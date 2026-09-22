import { formatInvokeError } from '../src/lib/formatInvokeError.ts';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(formatInvokeError({ Unknown: 'pip failed for reportlab' }) === 'pip failed for reportlab', 'Unknown enum');
assert(formatInvokeError({ message: 'boom' }) === 'boom', 'message field');
assert(formatInvokeError(new Error('x')) === 'x', 'Error');
assert(formatInvokeError('plain') === 'plain', 'string');
assert(!formatInvokeError({ a: 1 }).includes('[object Object]'), 'no object Object');
console.log('formatInvokeError ok');
