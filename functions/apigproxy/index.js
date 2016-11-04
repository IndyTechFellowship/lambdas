
// This lambda function acts as a proxy for the traffic between 
// slack and lambda. It allows us to sculpt a traffic pattern 
// that looks like (S: Sync, A: Async)
//
//   slack -S-> apig -S-> apigproxy -A-* handlerlambda
//     | <-----S-| <--------S-|                |
//     | <-----------------------------------S-|
//
// In essence: Slack requires we respond to its webhook within
// 3 seconds or it throws an error. This proxy will always do that.
// However: There are some lambdas which might want to take longer 
// than three seconds. So this will async invoke the lambda 
// and pass it the slack event. 
// The lambda will then respond using the respond_url slack provides,
// which has a cap of 30 minutes instead of 3 seconds. Magic!
//
// Lambdas which can normally execute within 3 seconds do not 
// need to use this proxy. They'll operate a bit faster if they don't.

const aws = require('aws-sdk')
const query = require('querystring')

const Lambda = new aws.Lambda()

exports.handle = (event, context) => {
  const body = query.parse(event.body)
  const command = body.command
  const done = (err) => {
    const resp = err 
      ? { statusCode: 500, headers: {}, body: err } 
      : { statusCode: 200, headers: {}, body: '' }
    return context.succeed(resp)
  }
  switch (command) {
    case '/speakeasy': InvokeSpeakeasy(body, done)
  }
}

const InvokeSpeakeasy = (body, done) => {
  Lambda.invoke({
    FunctionName: 'tfo_slack_speakeasy',
    // Other option is RequestResponse.
    // When we specify Event, it means the lambda is executed and we immediately 
    // return without waiting for it to finish.
    InvocationType: 'Event',
    Payload: JSON.stringify({
      body,
    }),
  }, done)
}