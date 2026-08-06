module.exports = {
  apps: [{
    name: "lana-carousel",
    script: "src/http-server.js",
    cwd: __dirname,
    node_args: "--env-file-if-exists=.env",
    env: {
      NODE_ENV: "production",
      PORT: "8787",
      PUBLIC_BASE_URL: "https://content.lanadesign.tech"
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 2000
  }]
};
