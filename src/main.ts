import { loadConfig } from './config/index.ts'; import { createApiServer } from './api/server.ts';
const config=loadConfig(process.env);const server=createApiServer({host:config.server.host,port:config.server.port,jwtSecret:config.auth.jwtSecret.reveal(),issuer:config.auth.jwtIssuer,audience:config.auth.jwtAudience});
await server.listen();console.log(`Rebuplica 27 API listening on ${config.server.host}:${config.server.port}`);
const shutdown=async(signal:string):Promise<void>=>{console.log(`Received ${signal}; shutting down`);await server.close();process.exitCode=0;};process.once('SIGINT',()=>{void shutdown('SIGINT');});process.once('SIGTERM',()=>{void shutdown('SIGTERM');});
