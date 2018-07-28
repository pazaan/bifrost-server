const _ = require('lodash');
const baseLog = require('bunyan').createLogger({
  name: 'bifrost-server',
});

function createLogger(filename, extraObjects) {
  const extras = _.cloneDeep(extraObjects == null ? {} : extraObjects);
  extras.srcFile = filename;

  return baseLog.child(extras);
}

module.exports = createLogger;
