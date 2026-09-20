import { randomUUID } from 'node:crypto';
import type { UserRepository, UserRecord } from '../persistence/ports.ts';
import { hashPassword,verifyPassword } from '../security/password.ts';
import { issueAccessToken } from '../security/jwt.ts';
import { ApiError } from './errors.ts';

export class AuthService {
  constructor(private readonly users:UserRepository,private readonly jwt:{secret:string;issuer:string;audience:string}){}
  async register(email:string,password:string):Promise<UserRecord>{const normalized=email.trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))throw new ApiError(400,'INVALID_EMAIL','Email is invalid');if(password.length<12)throw new ApiError(400,'WEAK_PASSWORD','Password must contain at least 12 characters');if(await this.users.findByEmail(normalized))throw new ApiError(409,'EMAIL_ALREADY_EXISTS','Email already exists');const user:UserRecord={id:randomUUID(),email:normalized,passwordHash:hashPassword(password),createdAt:new Date().toISOString()};try{await this.users.create(user);}catch(error){if(error instanceof Error&&error.message==='USER_EMAIL_CONFLICT')throw new ApiError(409,'EMAIL_ALREADY_EXISTS','Email already exists');throw error;}return user;}
  async login(email:string,password:string):Promise<{accessToken:string;user:UserRecord}>{const user=await this.users.findByEmail(email.trim().toLowerCase());if(!user||!verifyPassword(password,user.passwordHash))throw new ApiError(401,'INVALID_CREDENTIALS','Invalid credentials');return{user,accessToken:issueAccessToken(user.id,this.jwt.secret,this.jwt.issuer,this.jwt.audience)};}
}
