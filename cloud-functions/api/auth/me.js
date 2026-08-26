import { readSession } from "../../_lib/auth.js";
import { json } from "../../_lib/http.js";
export async function onRequest({ request, env }) { const session = await readSession(request, env); return json(session ? { authenticated: true, login: session.login } : { authenticated: false }); }
