import { ConfigError, loadConfig } from '../src/config/index.ts';
try {
  const config = loadConfig(process.env);
  console.log(JSON.stringify(config, null, 2));
} catch (error) {
  if (error instanceof ConfigError) { console.error(error.message); process.exitCode = 1; }
  else throw error;
}
