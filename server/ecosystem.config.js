module.exports = {
  apps: [{
    name: "satbank",
    script: "src/index.js",
    cwd: __dirname,
    instances: 1,          // single instance: socket rooms + sweep live in-process
    exec_mode: "fork",
    env: { NODE_ENV: "production" },
    max_restarts: 20,
    restart_delay: 3000,
  }],
};
