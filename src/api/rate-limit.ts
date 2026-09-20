export class RateLimiter {
  readonly #entries=new Map<string,{count:number;resetAt:number}>();
  readonly #limit:number; readonly #windowMs:number;
  constructor(limit:number,windowMs:number){this.#limit=limit;this.#windowMs=windowMs;}
  allow(key:string,now=Date.now()):boolean{const current=this.#entries.get(key);if(!current||current.resetAt<=now){this.#entries.set(key,{count:1,resetAt:now+this.#windowMs});return true;}if(current.count>=this.#limit)return false;current.count+=1;return true;}
}
