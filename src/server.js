'use strict';

require('dotenv').config({ quiet: true });
const { readConfig } = require('./config');
const { createApp } = require('./app');
const { createDatabase } = require('./db');

function startServer(env = process.env) {
  const config = readConfig(env);
  const db = createDatabase({ filename: config.dbPath });
  let app;
  try {
    app = createApp({ ...config, db });
  } catch (error) {
    db.close();
    throw error;
  }
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`ShoeShop listening on port ${config.port}; simulated checkout only.`);
  });
  server.on('error', () => {
    console.error('SERVER_LISTEN_FAILED: check the configured port.');
    if (db.open) db.close();
    app.locals.sessionStore.stopInterval?.();
    process.exitCode = 1;
  });
  let closing;
  function shutdown() {
    if (closing) return closing;
    closing = new Promise((resolve) => {
      const deadline = setTimeout(() => server.closeAllConnections(), 30000);
      deadline.unref();
      server.close(() => {
        clearTimeout(deadline);
        if (db.open) db.close();
        app.locals.sessionStore.stopInterval?.();
        resolve();
      });
      server.closeIdleConnections();
    });
    return closing;
  }
  return { app, server, db, shutdown };
}

if (require.main === module) {
  try {
    const { shutdown } = startServer();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    // Configuration messages are safe; native-driver/database errors may disclose local paths.
    console.error(error.message.startsWith('SESSION_SECRET') || error.message.startsWith('PORT')
      || error.message.startsWith('TRUST_PROXY') ? error.message : 'STARTUP_FAILED: check configuration and database readiness.');
    process.exitCode = 1;
  }
}

module.exports = { startServer };
