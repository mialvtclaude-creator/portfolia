// LucIA con IA: recibe una pregunta del juego y responde con Google Gemini (plan gratis).
// La clave GEMINI_API_KEY vive solo en los Secrets de Supabase; nunca en la página.
// Solo responde a personas con sesión iniciada en Portfolia.
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "gemini-3.5-flash-lite"; // gratis en el plan sin tarjeta de Google AI Studio

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

const GEMINI = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

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
    const r = await fetch(GEMINI, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")! },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: `<portafolio>${context}</portafolio>

${question}` }] }],
        generationConfig: { maxOutputTokens: 2000 },
      }),
    });
    if (r.status === 429) return json({ error: "LucIA está ocupada, intenta en un momento" }, 429);
    if (!r.ok) { console.error(r.status, await r.text()); return json({ error: "Error de la IA" }, 502); }
    const j = await r.json();
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    const reply = parts.filter((p: { text?: string; thought?: boolean }) => p.text && !p.thought).map((p: { text: string }) => p.text).join("").trim();
    return json({ reply: reply || "Esa pregunta no la puedo responder. Pregúntame sobre la bolsa, tu portafolio o el juego." });
  } catch (e) {
    console.error(e);
    return json({ error: "Error de la IA" }, 500);
  }
});
