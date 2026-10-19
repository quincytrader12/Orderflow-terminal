// Runs Vite and Electron together for desktop development.
import { spawn } from 'node:child_process';

const PORT = 5173;
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'inherit'] });
vite.stdout.on('data', (d) => {
  process.stdout.write(d);
  if (String(d).includes('Local')) {
    const app = spawn('npx', ['electron', '.'], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: `http://localhost:${PORT}/` } });
    app.on('exit', (code) => {
      vite.kill();
      process.exit(code ?? 0);
    });
  }
});
