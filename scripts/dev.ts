export {};
const processes = [
  Bun.spawn(['bun', 'src/cli.ts', '--dev'], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  }),
  Bun.spawn(['bun', 'x', 'vite'], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }),
];
const stop = () => {
  for (const p of processes) p.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await Promise.race(processes.map((p) => p.exited));
stop();
await Promise.all(processes.map((p) => p.exited));
