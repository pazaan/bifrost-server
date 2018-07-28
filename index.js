const _ = require('lodash');
const http = require('http');
// const https = require('https');
const ST = require('stjs');
const socketIO = require('socket.io');
const axios = require('axios');
const app = require('express')();
const httpProxy = require('http-proxy');

const flash = require('express-flash');
const bodyParser = require('body-parser');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
// const queryString = require('query-string');
const logMaker = require('./log.js');

const apiProxy = httpProxy.createProxyServer();
const log = logMaker('index.js', { level: 'debug' });

// TODO: add process.env to here instead, with default guards
const config = {};
config.httpPort = 1338;

app.set('view engine', 'pug');
app.use(session({
  store: new MemoryStore({
    checkPeriod: 86400000, // Prune expired entries every 24h
  }),
  secret: 'sessionSecret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
  },
}));
app.use(flash());
app.use(bodyParser.urlencoded({
  extended: false,
}));

// Authentication and Authorization Middleware
const auth = (req, res, next) => {
  log.info('In Auth');
  log.debug(req.session);
  if (req.headers['x-tidepool-session-token']) {
    log.info(`Set sessionToken: ${req.headers['x-tidepool-session-token']}`);
    req.session.sessionToken = req.headers['x-tidepool-session-token'];
  }

  if (!_.hasIn(req.session, 'sessionToken') && !_.hasIn(req.query, 'restricted_token')) {
    return res.redirect('/login');
  }

  return next();
};

function buildHeaders(requestSession) {
  log.debug('In buildHeaders');
  log.debug(requestSession);
  if (requestSession.sessionToken) {
    return {
      headers: {
        'x-tidepool-session-token': requestSession.sessionToken,
      },
    };
  }
  return {};
}

/*
async function getNightscoutData() {
  return await axios.get(`${process.env.NIGHTSCOUT_HOST}/api/v2/ddata/at`);
}
*/

function getPatientNameFromProfile(profile) {
  return (profile.patient.fullName) ? profile.patient.fullName : profile.fullName;
}

async function getTidepoolData() {
  const apiHost = process.env.CUSTOM_TIDEPOOL_HOST;
  const axiosConfig = {
    auth: {
      username: process.env.BIFROST_USERNAME,
      password: process.env.BIFROST_PASSWORD,
    },
  };
  const response = await axios.post(`${apiHost}/auth/login`, null, axiosConfig);
  const sessionToken = response.headers['x-tidepool-session-token'];
  const dataResponse = await axios.get(`${apiHost}/data/241358e456?startDate=2018-07-08T00:00:00.000Z&type=cbg,smbg,wizard,basal,pumpSettings`, {
    headers: {
      'x-tidepool-session-token': sessionToken,
    },
  });
  return dataResponse;
}

app.get('/login', (req, res) => {
  res.render('login', {
    flash: req.flash(),
  });
});

app.post('/login', async (req, res) => {
  req.session.apiHost = (req.body.environment === 'custom')
    ? process.env.CUSTOM_TIDEPOOL_HOST
    : `https://${req.body.environment}-api.tidepool.org`;

  try {
    const response = await axios.post(`${req.session.apiHost}/auth/login`, null, {
      auth: {
        username: req.body.username,
        password: req.body.password,
      },
    });
    req.session.sessionToken = response.headers['x-tidepool-session-token'];
    req.session.user = response.data;
    log.info(`User ${req.session.user.userid} logged into ${req.session.apiHost}`);
    log.debug(req.session);
    res.redirect('/users');
  } catch (error) {
    log.error(`Incorrect username and/or password for ${req.session.apiHost}`);
    req.flash('error', 'Username and/or password are incorrect');
    res.redirect('/login');
  }
});

app.get('/logout', (req, res) => {
  delete req.session.sessionToken;
  delete req.session.apiHost;
  res.redirect('/login');
});

app.get('/users', auth, async (req, res) => {
  log.debug('IN USERS');
  const userList = [];
  try {
    const profileResponse = await axios.get(`${req.session.apiHost}/metadata/${req.session.user.userid}/profile`, buildHeaders(req.session));
    userList.push({
      userid: req.session.user.userid,
      fullName: getPatientNameFromProfile(profileResponse.data),
    });
  } catch (error) {
    log.debug('Could not read profile. Probably a clinician account');
  }

  try {
    const userListResponse = await axios.get(`${req.session.apiHost}/metadata/users/${req.session.user.userid}/users`, buildHeaders(req.session));
    // TODO: options for the following line?
    // eslint-disable-next-line no-restricted-syntax
    for (const trustingUser of userListResponse.data) {
      if (trustingUser.trustorPermissions && trustingUser.trustorPermissions.view) {
        userList.push({
          userid: trustingUser.userid,
          fullName: getPatientNameFromProfile(trustingUser.profile),
        });
      }
    }

    log.debug(`Finiding env match for ${req.session.apiHost}`);
    const env = (_.isEmpty(req.session.apiHost.match(/.*:\/\/\w+-api.tidepool.org/))) ? 'custom' : req.session.apiHost.match(/.*:\/\/(\w+)-api.tidepool.org/)[1];

    res.render('users', {
      users: userList,
      env,
    });
  } catch (error) {
    log.error('Error fetching user list');
    log.error(error);
    req.flash('error', 'Error fetching user list');
    res.redirect('/login');
  }
});

app.post('/user', auth, async (req, res) => {
  log.debug(`Register new user ${req.body.userid} to env ${req.body.env}`);
  res.redirect('/login');
});

app.get('/socket.io', async (req, res, next) => next);

app.get('/api/v1/profile.json', async (req, res) => {
  const tpData = await getTidepoolData();
  // TODO: remove this when tp2ns goes into a module
  // eslint-disable-next-line no-use-before-define
  const parsed = ST.transform(tp2ns, tpData.data);
  res.send(parsed.profiles);
});

app.get('/api/v2/ddata/at', async (req, res) => {
  const tpData = await getTidepoolData();
  // TODO: remove this when tp2ns goes into a module
  // eslint-disable-next-line no-use-before-define
  const parsed = ST.transform(tp2ns, tpData.data);
  res.send(parsed);
});

app.all('*', async (req, res) => {
  log.info(`Proxying ${req.url}`);
  apiProxy.web(req, res, {
    target: process.env.NIGHTSCOUT_HOST,
  });
});

app.server = http.createServer(app).listen(config.httpPort, () => {
  log.info(`Listening for HTTP on ${config.httpPort}`);
});

const io = socketIO({
  transports: ['xhr-polling'],
  'log level': 0,
}).listen(app.server, {
  // these only effect the socket.io.js file that is sent to the client, but better than nothing
  'browser client minification': true,
  'browser client etag': true,
  'browser client gzip': false,
});

io.on('connection', (socket) => {
  // FIXME: Do the actual Auth here...
  log.info('*** Got connection');
  socket.emit('clients', 1);

  socket.on('authorize', (authData) => {
    log.info('*** Got Authorize request');
    log.info(authData);
    socket.join('DataReceivers');
    // FIXME: this needs to do delta loads
    log.info('*** Sending updates: ');
    setInterval(async () => {
      process.stdout.write('.');
      const tpData = await getTidepoolData();
      // TODO: remove this when tp2ns goes into a module
      // eslint-disable-next-line no-use-before-define
      const parsed = ST.transform(tp2ns, tpData.data);
      // FIXME: find a real way to show deltas
      if (parsed.sgvs.length > 0) {
        parsed.sgvs[parsed.sgvs.length - 1].direction = 'Flat';
      }
      io.to('DataReceivers').emit('dataUpdate', parsed);
    }, 10000);

    setTimeout(async () => {
      const tpData = await getTidepoolData();
      // TODO: remove this when tp2ns goes into a module
      // eslint-disable-next-line no-use-before-define
      const parsed = ST.transform(tp2ns, tpData.data);
      socket.emit('dataUpdate', parsed);
    }, 1000);
  });

  socket.on('nsping', (message, callback) => {
    const clientTime = message.mills;
    const timeDiff = new Date().getTime() - clientTime;
    log.info('Ping from client ID: ', socket.client.id, ' timeDiff: ', `${(timeDiff / 1000).toFixed(1)}sec`);
    if (callback) {
      callback({
        result: 'pong',
        mills: new Date().getTime(),
        authorization: null,
      });
    }
  });
});

// TODO: set same treatments.glucose and treatments.mgdl using #let?
// TODO: Move this template out to a module
const tp2ns = {
  sgvs: {
    '{{#each $root}}': [{
      "{{#if type === 'cbg'}}": {
        mgdl: [{
          "{{#if units === 'mmol/L'}}": '{{Math.round(value * 18.01559)}}',
        }, {
          '{{#else}}': '{{value}}',
        }],
        mills: '{{new Date(time).getTime()}}',
      },
    }],
  },
  treatments: {
    '{{#each $root}}': [{
      "{{#if type === 'smbg'}}": {
        _id: '{{id}}',
        eventType: 'BG Check',
        glucoseType: 'Finger',
        glucose: [{
          "{{#if units === 'mmol/L'}}": '{{Math.round(value * 18.01559)}}',
        }, {
          '{{#else}}': '{{value}}',
        }],
        mgdl: [{
          "{{#if units === 'mmol/L'}}": '{{Math.round(value * 18.01559)}}',
        }, {
          '{{#else}}': '{{value}}',
        }],
        units: 'mg/dl',
        created_at: '{{time}}',
        mills: '{{new Date(time).getTime()}}',
      },
    }, {
      // TODO: Merge with 'bolus' events to get delivery cancellations
      "{{#elseif type === 'wizard'}}": {
        _id: '{{id}}',
        eventType: "{{ ( typeof carbInput !== 'undefined' && carbInput !== 0 ? 'Meal Bolus' : 'Correction Bolus' )}}",
        // TODO: Are there glucoseTypes other than "Finger"? Can we even tell?
        glucoseType: "{{#? (bgInput ? 'Finger' : false)}}",
        glucose: '{{#? bgInput}}',
        // NS wants a BG in order to render the meal bolus, even if there was no BG :\
        mgdl: "{{#? (typeof bgInput === 'undefined' ? 180 : ( units === 'mg/dL' ? bgInput: false )) }}",
        mmol: "{{#? (units === 'mmol/L' ? bgInput : false) }}",
        units: [{
          "{{#if units === 'mmol/L'}}": 'mmol',
        }, {
          '{{#else}}': 'mg/dl',
        }],
        carbs: '{{#? carbInput}}',
        insulin: '{{#? recommended.net}}',
        created_at: '{{time}}',
        mills: '{{new Date(time).getTime()}}',
      },
    }, {
      "{{#elseif type === 'basal2'}}": {
        _id: '{{id}}',
        eventType: 'Temp Basal',
        // NS wants a BG in order to render the temp basal, even if there was no BG :\
        mgdl: 180,
        absolute: '{{rate}}',
        // NS duration is in minutes, TP is in milliseconds
        duration: '{{duration / 60000}}',
        created_at: '{{time}}',
        mills: '{{new Date(time).getTime()}}',
      },
    }],
  },
  tempbasalTreatments: {
    '{{#each $root}}': [{
      "{{#if type === 'basal'}}": {
        _id: '{{id}}',
        eventType: 'Temp Basal',
        // NS wants a BG in order to render the temp basal, even if there was no BG :\
        mgdl: 180,
        absolute: '{{rate}}',
        // NS duration is in minutes, TP is in milliseconds
        duration: '{{duration / 60000}}',
        created_at: '{{time}}',
        mills: '{{new Date(time).getTime()}}',
        endmills: '{{new Date(time).getTime() + duration}}',
      },
    }],
  },
  profiles: {
    '{{#each $root}}': [{
      "{{#if type === 'pumpSettings'}}": {
        mills: '{{new Date(time).getTime()}}',
        created_at: '{{time}}',
        startDate: '{{time}}',
        _id: '{{id}}',
        defaultProfile: '{{activeSchedule}}',
        units: [{
          "{{#if units.bg === 'mmol/L'}}": 'mmol',
        }, {
          '{{#else}}': 'mgdl',
        }],
        store: {
          'Auto Mode': {
            basal: [{
              time: '00:00',
              timeAsSeconds: '0',
              value: '0.000001',
            }],
            carbratio: [{
              time: '00:00',
              timeAsSeconds: '0',
              value: '6',
            }],
            sens: [{
              time: '00:00',
              timeAsSeconds: '0',
              value: '2.5',
            }],
            target_high: [{
              time: '00:00',
              timeAsSeconds: '0',
              value: '5.6',
            }],
            target_low: [{
              time: '00:00',
              timeAsSeconds: '0',
              value: '4.4',
            }],
            dia: '3.0',
            startDate: '2017-02-08T22:16:41+11:00',
            timezone: 'Australia/Sydney',
            units: 'mmol',
          },
        },
      },
    }],
  },
};
