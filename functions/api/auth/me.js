import { readSession } from "../../_lib/auth.js";
import { json } from "../../_lib/http.js";
export async function onRequest({ request }) { const session = await readSession(request); return json(session ? { authenticated: true, login: session.login } : { authenticated: false }); }

