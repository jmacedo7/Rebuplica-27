import { createServer,type IncomingMessage,type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ApiError } from './errors.ts';
import { json,parseJson,requireString } from './http.ts';
import { RateLimiter } from './rate-limit.ts';
import { verifyAccessToken } from '../security/jwt.ts';
import { AuthService } from './auth-service.ts';
import { InMemoryRepositories } from '../persistence/in-memory.ts';
export interface ApiServerOptions{host:string;port:number;jwtSecret:string;issuer:string;audience:string;}
export const createApiServer=(options:ApiServerOptions)=>{
 const repositories=new InMemoryRepositories(); const auth=new AuthService(repositories.users,{secret:options.jwtSecret,issuer:options.issuer,audience:options.audience}); const limiter=new RateLimiter(30,60_000);
 const handler=async(req:IncomingMessage,res:ServerResponse):Promise<void>=>{
  const requestId=randomUUID();res.setHeader('x-request-id',requestId);res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','no-referrer');
  try{const path=req.url?.split('?')[0]??'/';if(!limiter.allow(`${req.socket.remoteAddress??'unknown'}:${path}`))throw new ApiError(429,'RATE_LIMITED','Too many requests');
   if(req.method==='GET'&&path==='/health'){json(res,200,{status:'ok',service:'rebuplica-27',requestId});return;}
   if(req.method==='POST'&&path==='/auth/register'){const body=await parseJson(req);const user=await auth.register(requireString(body,'email',320),requireString(body,'password',200));json(res,201,{user:{id:user.id,email:user.email,createdAt:user.createdAt}});return;}
   if(req.method==='POST'&&path==='/auth/login'){const body=await parseJson(req);const result=await auth.login(requireString(body,'email',320),requireString(body,'password',200));json(res,200,{accessToken:result.accessToken,user:{id:result.user.id,email:result.user.email,createdAt:result.user.createdAt}});return;}
   if(req.method==='GET'&&path==='/auth/me'){const header=req.headers.authorization;if(!header?.startsWith('Bearer '))throw new ApiError(401,'UNAUTHORIZED','Authentication required');const claims=verifyAccessToken(header.slice(7),options.jwtSecret,options.issuer,options.audience);const user=await repositories.users.findById(claims.sub);if(!user)throw new ApiError(401,'UNAUTHORIZED','Authentication required');json(res,200,{user:{id:user.id,email:user.email,createdAt:user.createdAt}});return;}
   throw new ApiError(404,'NOT_FOUND','Route not found');
  }catch(error){if(error instanceof ApiError){json(res,error.status,{error:{code:error.code,message:error.message},requestId});return;}console.error({requestId,error});json(res,500,{error:{code:'INTERNAL_ERROR',message:'Internal server error'},requestId});}
 };
 const server=createServer(handler); return{server,listen:()=>new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port,options.host,()=>resolve());}),close:()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
};
