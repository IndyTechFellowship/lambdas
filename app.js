const LOCKS = {
  "bwo": "3768",
  "bwi": "3766",
  "bs": "3767",
  "do": "3641",
  "di": "3640",
}

const printHelp = () => {
  return "```\n"
    + "Control access to the SpeakEasy.\n"
    + "  /speakeasy help          :: display this text\n"
    + "  /speakeasy unlock {door} :: unlock a specific door\n"
    + "Doors:\n"
    + "  - bwo :: broad ripple / west side / outer\n"
    + "  - bwi :: broad ripple / west side / inner\n"
    + "  - bs  :: broad ripple / south side (parking lot)\n"
    + "  - do  :: downtown / outer\n"
    + "  - di  :: downtown / inner\n" 
    + "```"
}

const bunyan = require('bunyan')
const log = bunyan.createLogger({ name: 'tfo_slack' })

const express = require('express')
const app = express()

const bp = require('body-parser')
app.use(bp.json())
app.use(bp.urlencoded({
  extended: true
}))

const kisi = require('kisi-client')
const k = new kisi.default()

app.post('/speakeasy', (req, res) => {
  const text = req.body.text
  const split = text.split(" ")
  switch (split) {
    case 'help':
      return res.send(printHelp())
  }
  res.send("Great!")
})

app.listen(process.env.PORT, () => {
  log.info('server started')
})