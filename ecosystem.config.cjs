// bot-worker/ecosystem.config.cjs
// PM2 config for running the bot manager as a persistent service.
//
// Install PM2 globally: npm install -g pm2
//
// Start:          pm2 start ecosystem.config.cjs
// Auto-start on boot: pm2 startup  (follow the printed command)
//                     pm2 save
// View logs:      pm2 logs bot-manager
// Status:         pm2 status
// Stop:           pm2 stop bot-manager
// Restart:        pm2 restart bot-manager

module.exports = {
  apps: [
    {
      name: 'bot-manager',
      script: 'dist/manager.js',   // built output — run `npm run build` first
      cwd: __dirname,
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      // Restart delay after a crash
      restart_delay: 5000,
      // Environment — copy your .env values here or use a .env file
      env: {
        NODE_ENV: 'production',
        // FIREBASE_SERVICE_ACCOUNT_BASE64: 'paste_value_here'
        // Or create a .env file in this directory
      },
      // Logging
      out_file: './logs/manager-out.log',
      error_file: './logs/manager-error.log',
      time: true,
    },
  ],
};
