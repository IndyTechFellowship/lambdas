const _ = require('lodash')
const async = require('async')
const aws = require('aws-sdk')
const marshal = require('dynamodb-marshaler/marshal')
const moment = require('moment')
const request = require('request')
const unmarshalItem = require('dynamodb-marshaler').unmarshalItem

const DynamoDB = new aws.DynamoDB()

const N_PASSES = 10
const DOOR_CODES = [
  { name: "Brip West Outer", key: 'bwo', code: '3768' },
  { name: "Brip West Inner", key: 'bwi', code: '3766' },
  { name: "Brip Parking Lot", key: 'bs', code: '3767' },
  { name: "Downtown Outer", key: 'do', code: '3641' },
  { name: "Downtown Inner", key: 'di', code: '3640' },
]

// `event` isn't a normal slack+apig event; its already been parsed by 
// the apigproxy lambda from the querystring stuff that slack gives 
// us into a normal json object
exports.handle = (event, context) => {

  // Parse the incoming request
  const body = event.body
  if (!body) {
    console.error('No body provided')
    return 
  }

  // Helper function to respond to the request
  const finish = () => {
    return context.succeed({ statusCode: 200, headers: {}, body: '' })
  }
  const respond = (message, done) => {
    request({
      url: body.response_url,
      method: 'POST',
      body: JSON.stringify({
        text: message,
      }),
    }, (err, resp, body) => done(err, body))
  }
  const genericError = (done) => {
    return respond("I didn't catch that... try to run `/speakeasy help` for info on how to use this command.", done)
  }

  // Identify if there's an error or if the request is a simple help request
  const textSplit = body.text.split(" ")
  if (textSplit.length === 0) {
    return genericError(() => finish())
  }
  if (textSplit[0] === 'help') {
    return respond(GetHelp(), () => finish())
  }

  // Main logic
  async.waterfall([
    // Initialize state
    (done) => done(null, {
      args: textSplit,
      command: body.command,
      respond,
      token: body.token,
      user: { id: body.user_id },
    }),
    // Retrieve the slack auth token from DynamoDB
    GetSlackAuthToken,
    // Check to ensure it is the same as the one passed into the request
    CheckSlackAuthToken,
    // Get the requesting user 
    GetCallingUser,
    // Verify that they are enabled and are not rate limited
    CheckCallingUser,
    // Register that the user has made a request to the service
    // for ratelimiting purposes
    RegisterUserAttempt,
    // Get a list of valid logins from DynamoDB
    GetLogins,
    // Login the user to KISI with those valid credentials
    Login,
    // Dispatch to the appropriate request depending on the 
    // the command the user entered
    GetDispatchHandler,
  ], (err, message) => {
    if (err) console.error(err)
    return respond(err || message, () => finish())
  })
}

// ==================================================
// Generates and returns help text 
// ==================================================
const GetHelp = () => {
  return "*Controls access to the SpeakEasy*\n"
    + "```\n"
    + "/speakeasy help\n"
    + "```\n"
    + "_display this text_\n"
    + "```\n"
    + "/speakeasy status\n"
    + "```\n"
    + "_checks the status of our connection with the SpeakEasy and your checked-out pass_\n"
    + "```\n"
    + "/speakeasy checkout\n"
    + "```\n"
    + "_grants you a pass to access the SpeakEasy for 24 hours_\n"
    + "```\n"
    + "/speakeasy unlock {door}\n"
    + "```\n"
    + "_unlock a specific door_\n\n"
    + "*Doors*\n"
    + "  - `bwo`: broad ripple > west side > outer\n"
    + "  - `bwi`: broad ripple > west side > inner\n"
    + "  - `bw`: broad ripple > west side > outer then inner on a time delay\n"
    + "  - `bs`: broad ripple > south side (parking lot)\n"
    + "  - `do`: downtown > outer\n"
    + "  - `di`: downtown > inner\n" 
    + "\n\n"
    + "I'd recommend running `/speakeasy status` before making a trip to the SpeakEasy "
    + "of your choice. If the status check comes back operational then you should be good to go.\n"
    + "Some functionality of this app is rate-limited.\n"
    + "Please keep in mind that you may stay in the SpeakEasy 24/7, but the doors to get in do lock "
    + "at 10pm in Broad Ripple and a bit earlier Downtown. `/speakeasy status` will reflect this.\n"
    + "Contact Mike with any questions or concerns."
}

// ==================================================
// Returns the authorization token from slack to 
// ensure requests originate from Slack
// ==================================================
const GetSlackAuthToken = (state, done) => {
  DynamoDB.getItem({
    TableName: 'SlackSpeakeasyData',
    Key: { key: { S: 'slack_auth_token' } },
  }, (err, item) => {
    if (err) {
      console.error(`GetSlackAuthToken :: DynamoDB error: ${err}`)
      return done(err)
    }
    if (!item.Item) {
      return done("I can't confirm that this request is originating from Slack.")
    }
    state.canonicalToken = unmarshalItem(item.Item).value
    return done(null, state)
  })
}

// ==================================================
// Checks to ensure the slack auth token passed 
// into the request is the same as the one from 
// dynamodb
// ==================================================
const CheckSlackAuthToken = (state, done) => {
  if (state.canonicalToken !== state.token) {
    return done('Cannot verify request originated from Slack... exiting.')
  }
  return done(null, state)
}

// ==================================================
// Returns the DynamoDB document for the calling user.
// ==================================================
const GetCallingUser = (state, done) => {
  DynamoDB.getItem({
    TableName: 'TFoSlackUsers',
    Key: { id: { S: state.user.id } },
  }, (err, item) => {
    if (err) {
      console.error(`GetCallingUser :: DynamoDB error: ${err}`)
      return done(err)
    }
    if (!item.Item) {
      return done("I can't find a record of you in my database. Please contact Mike to have your access to this service enabled.")
    }
    state.user = unmarshalItem(item.Item)
    return done(null, state)
  })
}

// ==================================================
// Checks to ensure the calling user is capable of
// making the call to KISI. Rate limiting, feature 
// toggling, etc. 
// ==================================================
const CheckCallingUser = (state, done) => {
  const user = state.user
  if (!user) 
    return done('Cannot proceed without a recognized user')
  if (!_.get(user, 'speakeasy.enabled')) 
    return done('Rollout of this service is currently limited, and your account is not enabled.')

  // Only allow a maximum of 3 attempts per 60 seconds
  const attempts = _.get(user, 'speakeasy.attempts')
  const disabled = _.get(user, 'speakeasy.disableRateLimiting')
  if (!attempts || attempts.length < 3 || disabled) return done(null, state)

  // Otherwise, we need to read in the times and figure out how many 
  // have happened in the last minute.
  const lastMinute = _.filter(attempts, (a) => {
    return moment(a.at).isAfter(moment().subtract(1, 'minute'))
      && _.includes([ 'checkout', 'status', 'unlock', 'open' ], a.op)
  })
  if (lastMinute.length >= 3) 
    return done(`` + 
      `Requests to this service are limited to 3 every 60 seconds.\n`+
      `Please wait for a few seconds and try again.\n` +
      "This request has not counted against your 3 requests; only successful `checkout`, `status`, and `unlock` requests count.")

  return done(null, state)
}

// ==================================================
// Register the time the user just attempted to 
// access this service so they can be properly rate
// limited the next time
// ==================================================
const RegisterUserAttempt = (state, done) => {
  var previousAttempts = _.get(state, 'user.speakeasy.attempts')
  if (!previousAttempts) previousAttempts = []
  previousAttempts.unshift({
    at: moment().toISOString(),
    op: state.command,
  })

  // Only store the last 5 attempts the user has made, to save storage room
  if (previousAttempts.length > 5) previousAttempts = _.take(previousAttempts, 5)

  DynamoDB.updateItem({
    TableName: 'TFoSlackUsers',
    Key: { id: { S: state.user.id } },
    UpdateExpression: 'set #s.#a = :p',
    ExpressionAttributeNames: {
      '#s': 'speakeasy',
      '#a': 'attempts',
    },
    ExpressionAttributeValues: {
      ':p': marshal(previousAttempts),
    },
  }, (err) => {
    if (err) {
      console.error(`RegisterUserAttempt :: ${err}`)
      return done(err)
    }
    return done(null, state)
  })
}

// ==================================================
// Returns a list of valid login credentials for 
// the kisi app 
// ==================================================
const GetLogins = (state, done) => {
  DynamoDB.getItem({
    TableName: 'SlackSpeakeasyData',
    Key: { key: { S: 'logins' } },
  }, (err, item) => {
    if (err) {
      console.error(`GetLogins :: DynamoDB error: ${err}`)
      return done(err)
    }
    if (!item.Item) {
      return done("Valid KISI login list cannot be found. I can't proceed.")
    }
    state.logins = unmarshalItem(item.Item).value
    return done(null, state)
  })
}

// ==================================================
// Logs in a user given the array of valid login 
// credentials. Returns a map of headers which should 
// be included with every future request
// ==================================================
const Login = (state, done) => {
  // Pick a random login from the list of valid credentials
  // This allows us to store multiple logins and rotate requests between them, so we don't
  // overuse a single login
  const validCredentials = state.logins
  const login = validCredentials[Math.floor(Math.random() * validCredentials.length)]
  request({
    url: 'https://api.getkisi.com/logins/sign_in',
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      "user": {
        "email": login.username,
        "password": login.password,
      },
    }),
  }, (err, resp, body) => {
    if (err) return done(err)
    body = JSON.parse(body)
    state.headers = {
      'accept': 'application/json',
      'content-type': 'application/json',
      'x-login-secret': body.secret,
    }
    done(null, state)
  })
}

// ==================================================
// Returns the handler which will execute the actual 
// command.
// ==================================================
const GetDispatchHandler = (state, done) => {
  switch (state.command) {
    case 'status':
      return StatusHandler(state, done)
    case 'checkout':
      return CheckoutHandler(state, done)
    case 'unlock': case 'open':
      return UnlockHandler(state, done)
  }
  return done('Command not recognized. Try `/speakeasy help` to start.')
}

// ==================================================
// Status handler. Handles /speakeasy status
// ==================================================
const StatusHandler = (state, done) => {
  async.map(DOOR_CODES, GetDoorStatus(state), (err, doorStatuses) => {
    if (err) {
      console.error(err)
      return done('An error occurred... let Mike know.')
    }
    var message = _.reduce(doorStatuses, (sum, status, i) => {
      if (i !== 0) sum += "\n"
      sum += status
      return sum
    }, "")
    message = ""
      + "I'm reading the lock statuses as follows\n"
      + message + "\n"
    DynamoDB.scan({
      TableName: 'TFoSlackUsers',
    }, (err, items) => {
      if (err) return done(err)
      const allUsers = items.Items.map(unmarshalItem)
      // Figure out how many users have active passes and print that as well. 
      const havePasses = _.filter(allUsers, (u) => moment(u.speakeasy.expires).isAfter(moment()))
      message += `Right now, there are ${havePasses.length} passes checked out, out of ${N_PASSES} total.\n`
      const userExpires = state.user.speakeasy.expires
      if (userExpires) {
        const inEnglish = moment(userExpires).from(moment())
        if (moment(userExpires).isBefore(moment())) {
          message += `Your last pass expired ${inEnglish}. `
          message += "Run `/speakeasy checkout` to get a new one."
        } else {
          message += `You have an active pass which expires ${inEnglish}.`
        }
      } else {
        message += "You haven't checked out a pass yet. Try `/speakeasy checkout` if you'd like one!"
      }
      return done(null, message)
    })
  })
}

// ==================================================
// Handles getting the status for a single door 
// and returning a printable string
// ==================================================
const GetDoorStatus = (state) => {
  return (door, doorDone) => {
    request({
      url: `https://api.getkisi.com/locks/${door.code}/peek`,
      method: 'POST',
      headers: state.headers,
    }, (err, resp, body) => {
      if (err) {
        console.error(err)
        return doorDone(null, `:warning: ${door.name} [\`${door.key}\`]: \`A bad error occurred.\``)
      }
      body = JSON.parse(body)
      const emoji = body.message === 'Access not restricted!'
        ? ':+1:'
        : ':no_good:'
      return doorDone(null, `${emoji} ${door.name} [\`${door.key}\`]: \`${body.message}\``)
    })
  }
}

// ==================================================
// Checks out a pass to the speakeasy for 24 hours
// ==================================================
const CheckoutHandler = (state, done) => {
  async.waterfall([
    (stepDone) => {
      DynamoDB.scan({
        TableName: 'TFoSlackUsers',
      }, (err, items) => {
        if (err) return stepDone(err)
        items = items.Items.map(unmarshalItem)
        state.allUsers = items
        stepDone()
      })
    },
    (stepDone) => {
      // Determine if we have already assigned the max number 
      // of passes.
      const havePasses = _.filter(state.allUsers, (u) => moment(u.speakeasy.expires).isAfter(moment()))
      if (havePasses.length >= N_PASSES) {
        return stepDone("Unfortunately, it looks like all the current passes have been checked out. Please try again within the next 24 hours.")
      }
      return stepDone()
    },
    (stepDone) => {
      DynamoDB.updateItem({
        TableName: 'TFoSlackUsers',
        Key: { id: { S: state.user.id } },
        UpdateExpression: 'set #s.#l = :s',
        ExpressionAttributeNames: {
          '#s': 'speakeasy',
          '#l': 'expires',
        },
        ExpressionAttributeValues: {
          ':s': { S: moment().add(24, 'hours').toISOString() },
        },
      }, stepDone)
    },
  ], (err) => {
    if (err) {
      console.error(`RegisterUserAttempt :: ${err}`)
      return done(err)
    }
    return done(null, "Your pass has been extended for 24 hours. Enjoy!")
  })
}

// ==================================================
// Handles a unlock request
// ==================================================
const UnlockHandler = (state, done) => {
  if (state.args.length < 1) return done('Please provide a door to unlock.')
  const doorKey = (() => {
    if (state.args[0] === 'bw') {
      return [
        _.find(DOOR_CODES, (c) => c.key === 'bwo'),
        _.find(DOOR_CODES, (c) => c.key === 'bwi'),
      ] 
    } else {
      const door = _.find(DOOR_CODES, (c) => c.key === state.args[0].toLowerCase())
      if (!door) return "Sorry, but I don't recognize that door. Please run `/speakeasy help` for more info."
      return [ door ]
    }
  })()
  if (_.isString(doorKey)) return done(doorKey)
  async.waterfall([
    (stepDone) => {
      if (!state.user.speakeasy.expires) {
        return stepDone("Please run `/speakeasy checkout` to get a pass to access the SpeakEasy.")
      }
      // Check to ensure the user's pass is valid
      if (moment(state.user.speakeasy.expires).isBefore(moment())) {
        return stepDone("Your pass has expired. Re-run `/speakeasy checkout` to assign yourself a new pass.")
      }
      stepDone()
    },
    (stepDone) => {
      async.eachOf(doorKey, (door, i, unlockDone) => {
        const timeout = i > 0 ? 10000 : 10
        setTimeout(() => {
          request({
            url: `https://api.getkisi.com/locks/${door.code}/unlock`,
            method: 'POST',
            headers: state.headers,
          }, (err, resp, body) => {
            if (err) console.error(err)
            const message = err ? err : JSON.parse(body).message
            state.respond(`${door.name}: ${message}`, (err) => {
              if (err) console.error(err)
              return unlockDone()
            })
          })
        }, timeout)
      }, stepDone)
    },
  ], (err, unlockBody) => {
    return done(err)
  })
}
