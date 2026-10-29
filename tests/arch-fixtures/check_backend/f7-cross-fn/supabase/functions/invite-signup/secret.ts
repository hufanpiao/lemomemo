export const readSecret = () => Deno.env.get('SIGNUP_HASH_SECRET');
