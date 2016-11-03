const _ = require('lodash')
const async = require('async')
const aws = require('aws-sdk')
const moment = require('moment')
const request = require('request')
const query = require('querystring')
const unmarshalItem = require('dynamodb-marshaler').unmarshalItem

const DynamoDB = new aws.DynamoDB()

const DOOR_CODES = [
  { name: "Brip West Outer", key: 'bwo', code: '3768' },
  { name: "Brip West Inner", key: 'bwi', code: '3766' },
  { name: "Brip Parking Lot", key: 'bs', code: '3767' },
  { name: "Downtown Outer", key: 'do', code: '3641' },
  { name: "Downtown Inner", key: 'di', code: '3640' },
]

exports.handle = (event, context) => {

  // Helper function to respond to the request
  const respond = (message) => {
    return context.succeed({ statusCode: 200, headers: {}, body: message })
  }
  const genericError = () => {
    return respond("I didn't catch that... try to run `/speakeasy help` for info on how to use this command.")
  }

  // Parse the incoming request
  const body = query.parse(event.body)
  const textSplit = body.text.split(" ")

  // Identify if there's an error or if the request is a simple help request
  if (textSplit.length === 0) return genericError()
  if (textSplit[0] === 'help') return respond(GetHelp())

  // Main logic
  async.waterfall([
    // Retrieve the slack auth token from DynamoDB
    GetSlackAuthToken(),
    // Check to ensure it is the same as the one passed into the request
    CheckSlackAuthToken(body.token),
    // Get the requesting user 
    GetCallingUser(body.user_id),
    // Verify that they are enabled and are not rate limited
    CheckCallingUser(),
    // Register that the user has made a request to the service
    // for ratelimiting purposes
    RegisterUserAttempt(),
    // Get a list of valid logins from DynamoDB
    GetLogins(),
    // Login the user to KISI with those valid credentials
    Login(),
    // Dispatch to the appropriate request depending on the 
    // the command the user entered
    GetDispatchHandler(textSplit),
  ], (err, message) => {
    if (err) return respond(err)
    return respond(message)
  })
}

// ==================================================
// Generates and returns help text 
// ==================================================
const GetHelp = () => {
  return "```\n"
    + "Control access to the SpeakEasy.\n"
    + "  /speakeasy help\n"
    + "   display this text\n"
    + "  /speakeasy status\n"
    + "   checks the status of our connection\n" 
    + "   with the SpeakEasy\n"
    + "  /speakeasy unlock {door}\n"
    + "   unlock a specific door\n"
    + "Doors\n"
    + "  - bwo\n"
    + "  broad ripple > west side > outer\n"
    + "  - bwi\n"
    + "  broad ripple > west side > inner\n"
    + "  - bs\n"
    + "  broad ripple > south side (parking lot)\n"
    + "  - do\n"
    + "  downtown > outer\n"
    + "  - di\n"
    + "  downtown > inner\n" 
    + "```\n\n"
    + "Generally, I'd recommend running `/speakeasy status` before making a trip to the SpeakEasy "
    + "of your choice. If the status check comes back operational then you should be good to go.\n\n"
    + "You are limited to 1 unlock every 60 seconds.\n\n"
    + "It is totally possible that this thing would just... not work. That being said, it should be "
    + "as available as the KISI app itself is.\n\n"
    + "Contact Mike with any questions or concerns."
}

// ==================================================
// Returns the authorization token from slack to 
// ensure requests originate from Slack
// ==================================================
const GetSlackAuthToken = () => {
  return (done) => {
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
      return done(null, unmarshalItem(item.Item).value)
    })
  }
}

// ==================================================
// Checks to ensure the slack auth token passed 
// into the request is the same as the one from 
// dynamodb
// ==================================================
const CheckSlackAuthToken = (fromRequest) => {
  return (fromDynamo, done) => {
    if (fromRequest !== fromDynamo) {
      return done('Cannot verify request originated from Slack... exiting.')
    }
    return done()
  }
}

// ==================================================
// Returns the DynamoDB document for the calling user.
// ==================================================
const GetCallingUser = (userId) => {
  return (done) => {
    DynamoDB.getItem({
      TableName: 'TFoSlackUsers',
      Key: { id: { S: userId } },
    }, (err, item) => {
      if (err) {
        console.error(`GetCallingUser :: DynamoDB error: ${err}`)
        return done(err)
      }
      if (!item.Item) {
        return done("User not found in bot database; Apologies, but I can't proceed.")
      }
      return done(null, unmarshalItem(item.Item))
    })
  }
}

// ==================================================
// Checks to ensure the calling user is capable of
// making the call to KISI. Rate limiting, feature 
// toggling, etc. 
// ==================================================
const CheckCallingUser = () => {
  return (user, done) => {
    if (!user) 
      return done('Cannot proceed without a recognized user')
    if (!_.get(user, 'speakeasy.enabled')) 
      return done('Rollout of this service is currently limited, and your account is not enabled.')
    if (_.get(user, 'speakeasy.lastAccess')) {
      const diff = moment().diff(moment(user.speakeasy.lastAccess), 'seconds')
      if (diff < 60) {
        const remaining = 60 - diff
        return done(`Requests to this service are limited to one every 60 seconds. Please wait ${remaining} seconds.`)
      }
    }
    return done(null, user)
  }
}

// ==================================================
// Register the time the user just attempted to 
// access this service so they can be properly rate
// limited the next time
// ==================================================
const RegisterUserAttempt = () => {
  return (user, done) => {
    DynamoDB.updateItem({
      TableName: 'TFoSlackUsers',
      Key: { id: { S: user.id } },
      UpdateExpression: 'set #s.#l = :s',
      ExpressionAttributeNames: {
        '#s': 'speakeasy',
        '#l': 'lastAccess',
      },
      ExpressionAttributeValues: {
        ':s': { S: moment().toISOString() },
      },
    }, (err, resp) => {
      if (err) {
        console.error(`RegisterUserAttempt :: ${err}`)
        return done(err)
      }
      return done()
    })
  }
}

// ==================================================
// Returns a list of valid login credentials for 
// the kisi app 
// ==================================================
const GetLogins = () => {
  return (done) => {
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
      return done(null, unmarshalItem(item.Item).value)
    })
  }
}

// ==================================================
// Logs in a user given the array of valid login 
// credentials. Returns a map of headers which should 
// be included with every future request
// ==================================================
const Login = () => {
  return (validCredentials, done) => {
    // Pick a random login from the list of valid credentials
    // This allows us to store multiple logins and rotate requests between them, so we don't
    // overuse a single login
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
      body = JSON.parse(body)
      done(err, {
        'accept': 'application/json',
        'content-type': 'application/json',
        'x-login-secret': body.secret,
      })
    })
  }
}

// ==================================================
// Returns the handler which will execute the actual 
// command.
// ==================================================
const GetDispatchHandler = (splitCommand) => {
  switch (splitCommand[0]) {
    case 'status':
      return StatusHandler()
    case 'unlock': case 'open':
      return UnlockHandler(splitCommand[1])
  }
  return (headers, done) => {
    return done('Command not recognized. Try `/speakeasy help` to start.')
  }
}

// ==================================================
// Status handler. Handles /speakeasy status
// ==================================================
const StatusHandler = () => {
  return (headers, done) => {
    async.map(DOOR_CODES, GetDoorStatus(headers), (err, doorStatuses) => {
      if (err) {
        console.error(err)
        return done('An error occurred... let Mike know.')
      }
      const message = _.reduce(doorStatuses, (sum, status, i) => {
        if (i !== 0) sum += "\n"
        sum += status
        return sum
      }, "")
      return done(""
        + "I'm reading the lock statuses as follows\n"
        + "```\n"
        + message + "\n"
        + "```\n"
        + "If any of those look off, its possible your phone could still work to unlock it, but not guaranteed.")
    })
  }
}

// ==================================================
// Handles getting the status for a single door 
// and returning a printable string
// ==================================================
const GetDoorStatus = (headers) => {
  return (door, doorDone) => {
    request({
      url: `https://api.getkisi.com/locks/${door.code}/peek`,
      method: 'POST',
      headers,
    }, (err, resp, body) => {
      if (err) {
        console.error(err)
        return doorDone(null, `${door.name} [${door.key}]:\n A bad error occurred.`)
      }
      body = JSON.parse(body)
      return doorDone(null, `${door.name} [${door.key}]:\n ${body.message}`)
    })
  }
}

// ==================================================
// Handles a unlock request
// ==================================================
const UnlockHandler = (doorKey) => {
  return (headers, done) => {
    const door = _.find(DOOR_CODES, (c) => c.key === doorKey)
    if (!door) return done("Sorry, but I don't recognize that door. Please run `/speakeasy help` for more info.")  
    request({
      url: `https://api.getkisi.com/locks/${door.code}/unlock`,
      method: 'POST',
      headers,
    }, (err, resp, body) => {
      if (err) return done(err)
      body = JSON.parse(body)
      return done(null, body.message)
    })
  }
}
