import { inspect } from 'node:util';
const REDACTED='[REDACTED]';
export class Secret<T=string>{readonly #value:T;constructor(value:T){this.#value=value;}reveal():T{return this.#value;}toString():string{return REDACTED;}toJSON():string{return REDACTED;}[inspect.custom]():string{return `Secret(${REDACTED})`;}}
