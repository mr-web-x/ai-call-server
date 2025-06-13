//для установления времени Братислава на AWS
module.exports = {
  apps: [
    {
      name: 'aiCallServer',
      script: './server.js',
      env: {
        NODE_ENV: 'production',
        TZ: 'Europe/Bratislava',
      },
    },
  ],
};
