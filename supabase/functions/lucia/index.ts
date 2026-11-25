// LucIA con IA: recibe una pregunta del juego y responde con Google Gemini (plan gratis).
// La clave GEMINI_API_KEY vive solo en los Secrets de Supabase; nunca en la página.
// Solo responde a personas con sesión iniciada en Portfolia.
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "gemini-3.5-flash-lite"; // gratis en el plan sin tarjeta de Google AI Studio

const SYSTEM = `Eres LucIA, la tutora de Portfolia, un juego educativo en español sobre la bolsa de Nueva York (NYSE) con dinero virtual.
- Explica con palabras sencillas, para alguien que está empezando. Respuestas cortas: de 2 a 5 frases, sin tablas ni encabezados.
- Puedes usar los datos del portafolio del jugador que vienen en <portafolio> para dar ejemplos y describir su situación.
- Si <portafolio> trae "mercado", son precios y titulares reales de Finnhub de ese momento: úsalos para responder sobre lo que pasa hoy, di la fecha y la fuente del titular, y no inventes noticias ni cifras que no estén ahí. Si no hay datos de la empresa por la que preguntan, dilo y sugiere poner la clave de Finnhub en ⚙.
- Es solo educativo: nunca digas qué comprar, vender o cuánto invertir, ni prometas ganancias. Si te lo piden, explica los conceptos que ayudan a decidir y recuerda que no das recomendaciones personalizadas de inversión.
- Si la pregunta no tiene que ver con finanzas, la bolsa o el juego, responde con amabilidad que solo ayudas con eso.
- Responde siempre en español.`;

// modo informe: el jugador pidió un informe, un análisis de errores o una proyección; los datos vienen en "informe"
const INFORME = `

MODO INFORME (reemplaza la regla de respuestas cortas):
- Usa solo los números de "informe" (y "mercado" si viene); no inventes cifras. Redondea y escribe montos como $12,345.
- Sin markdown: nada de asteriscos ni #. Cada sección empieza con su título en MAYÚSCULAS en su propia línea, y los puntos con "• ".
- Si piden un informe completo, haz tres secciones: RENDIMIENTO, ERRORES Y APRENDIZAJES, PROYECCIÓN. Si piden solo una cosa, haz solo esa sección, más completa.
- RENDIMIENTO: patrimonio inicial y actual, retorno frente al S&P 500, ganancia realizada, comisiones, aciertos en ventas, caída máxima y qué posiciones aportan más y menos.
- ERRORES Y APRENDIZAJES: parte de "alertas" y de las "operaciones" (cita la empresa y la fecha o día). Explica por qué cada patrón es un error común y qué hábito general lo evita (diversificar, stop-loss, no perseguir subidas, no vender en pánico, operar menos). Menciona también algo que hizo bien. Si no hay errores claros, dilo.
- PROYECCIÓN: da el rango pesimista, medio y optimista a 1 y 5 años de "proyeccion", explica qué significa ese rango y aclara que sale de supuestos del juego, que no es una predicción y que el futuro puede quedar fuera de él.
- Máximo unas 350 palabras en total. Termina con una línea recordando que es educativo y no una recomendación de inversión.`;

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

  let question = "", context = "", informe = false;
  // conversación previa: Gemini pide turnos que alternan y empiezan por el usuario, así que se juntan los seguidos
  const contents: { role: string; parts: { text: string }[] }[] = [];
  try {
    const b = await req.json();
    question = String(b.question ?? "").trim().slice(0, 600);
    informe = b.modo === "informe";
    context = String(b.context ?? "").slice(0, informe ? 14000 : 6000);
    for (const m of Array.isArray(b.history) ? b.history.slice(-10) : []) {
      const role = m?.role === "user" ? "user" : "model", text = String(m?.text ?? "").slice(0, 600);
      if (!text || (!contents.length && role === "model")) continue;
      const last = contents[contents.length - 1];
      if (last?.role === role) last.parts[0].text += "\n" + text;
      else contents.push({ role, parts: [{ text }] });
    }
  } catch { return json({ error: "Pregunta inválida" }, 400); }
  if (!question) return json({ error: "Escribe una pregunta" }, 400);
  const now = `<portafolio>${context}</portafolio>\n\n${question}`;
  if (contents[contents.length - 1]?.role === "user") contents[contents.length - 1].parts[0].text += "\n" + now;
  else contents.push({ role: "user", parts: [{ text: now }] });

  try {
    const r = await fetch(GEMINI, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")! },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: informe ? SYSTEM + INFORME : SYSTEM }] },
        contents,
        generationConfig: { maxOutputTokens: informe ? 4000 : 2000 },
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
