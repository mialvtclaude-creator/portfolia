// LucIA con IA: recibe una pregunta del juego y responde con Claude.
// La clave ANTHROPIC_API_KEY vive solo en los Secrets de Supabase; nunca en la página.
// Solo responde a personas con sesión iniciada en Portfolia.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-opus-5-5"; // para gastar menos: "claude-haiku-5-5"

const SYSTEM = `Eres LucIA, la tutora de Portfolia, un juego educativo en español sobre la bolsa de Nueva York (NYSE) con dinero virtual.
- Explica con palabras sencillas, para alguien que está empezando. Respuestas cortas: de 2 a 5 frases, sin tablas ni encabezados.
- Puedes usar los datos del portafolio del jugador que vienen en <portafolio> para dar ejemplos y describir su situación.
- Es solo educativo: nunca digas qué comprar, vender o cuánto invertir, ni prometas ganancias. Si te lo piden, explica los conceptos que ayudan a decidir y recuerda que no das recomendaciones personalizadas de inversión.
- Si la pregunta no tiene que ver con finanzas, la bolsa o el juego, responde con amabilidad que solo ayudas con eso.
- Responde siempre en español.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const anthropic = new Anthropic(); // lee ANTHROPIC_API_KEY de los Secrets

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Usa POST" }, 405);

  // solo usuarios con sesión: se comprueba el token con Supabase
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return json({ error: "Inicia sesión para hablar con LucIA" }, 401);

  let question = "", context = "";
  try {
    const b = await req.json();
    question = String(b.question ?? "").trim().slice(0, 600);
    context = String(b.context ?? "").slice(0, 3000);
  } catch { return json({ error: "Pregunta inválida" }, 400); }
  if (!question) return json({ error: "Escribe una pregunta" }, 400);

  try {
    const r = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // si el modelo declina por seguridad, otro modelo intenta responder
      system: SYSTEM,
      messages: [{ role: "user", content: `<portafolio>${context}</portafolio>\n\n${question}` }],
    });
    if (r.stop_reason === "refusal") return json({ reply: "Esa pregunta no la puedo responder. Pregúntame sobre la bolsa, tu portafolio o el juego." });
    const reply = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    return json({ reply: reply || null });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "LucIA está ocupada, intenta en un momento" }, 429);
    if (e instanceof Anthropic.APIError) { console.error(e.status, e.message); return json({ error: "Error de la IA" }, 502); }
    console.error(e);
    return json({ error: "Error de la IA" }, 500);
  }
});
