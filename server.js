require('dotenv').config();
const express = require('express');
const helmet = require("helmet");
const cors = require('cors');

require('dotenv').config();
const axios = require('axios');
const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');
const corsOptions = require('./config/corsoptions')


const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
});
const index = pinecone.Index('pdf-chunks-poc-sa');

// 2) Init OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
app.use(express.json());
app.use(helmet())



app.use(cors(corsOptions));
app.use(express.urlencoded({ extended: true }));


// app.post('/chat', async (req, res) => {
//   const { regionId, question, session_id } = req.body;

//   // start history immediately
//   const historyPromise = axios.post(
//     'https://x3kb-thkl-gi2q.n7e.xano.io/api:hWPNd5f8/get_history',
//     { session_id, message: question },
//     { headers: { 'Content-Type': 'application/json' } }
//   );

//   // start embedding
//   const embResp = await openai.embeddings.create({
//     model: 'text-embedding-3-small',
//     input: question,
//   });
//   const qEmb = embResp.data[0].embedding;

//   // start pinecone query as soon as we have the embedding
//   const pinePromise = index.query({
//     vector: qEmb,
//     topK: 3, // lower = faster serialization + faster LLM context
//     includeMetadata: true,
//     filter: { regionId },
//   });

//   const [historyRes, pineResp] = await Promise.all([historyPromise, pinePromise]);
//   const history = historyRes.data.history;
//   const snippets = (pineResp.matches || []).map(m => {
//     const { sourcePdf, chunkIndex, text = '<no text>' } = m.metadata || {};
//     return `(${sourcePdf}, chunk #${chunkIndex}):\n${text}`;
//   });

//   const ragContext =
//     `You are an expert on regional geology, region: ${regionId}, democratic republic of the congo. Prefer the snippets; if empty, use your own knowledge.\n\n` +
//     `CONTEXT:\n${snippets.join('\n---\n')}`;

//   const messages = [
//     { role: 'developer', content: ragContext },
//     // optional: only last 8-12 turns to keep tokens low
//     ...history.slice(-12),
//   ];

// const chatResp = await openai.responses.create({
//   model: 'gpt-4.1-nano-2025-04-14',
//   input: messages
// });

// const assistantReply = chatResp.output_text;

// //console.log('chatresp:', chatResp);


//   // respond to the user ASAP
//   res.json({ answer: assistantReply });

//   // do the logging/save OUTSIDE the response path (don’t await)
//   axios.post("https://x3kb-thkl-gi2q.n7e.xano.io/api:hWPNd5f8/llm_responses_save", {
//     prompt: question,
//     session_id,
//     response: assistantReply,
//     metadata: { inputPrompts: [question], result: assistantReply },
//     regionId
//   }, { headers: { "Content-Type": "application/json" } })
//   .catch(err => console.error('save failed', err));
// });

app.post('/chat_sa', async (req, res) => {
  const { regionId, question, session_id } = req.body;

  // kick off history save immediately
  const historyPromise = axios.post(
    'https://x3kb-thkl-gi2q.n7e.xano.io/api:cWjxJO0v/get_history_sa',
    { session_id, message: question },
    { headers: { 'Content-Type': 'application/json' } }
  );

  // embedding
  const embResp = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: question,
  });
  const qEmb = embResp.data[0].embedding;

  // pinecone: region-specific and generic, in parallel
  const pineRegionPromise = index.query({
    vector: qEmb,
    topK: 5,
    includeMetadata: true,
    filter: { map:"sa" }, // e.g., "katanga", "kivu", etc.
  });

  // NOTE: you wrote 'genric'—use the canonical 'generic'
  const pineGenericPromise = index.query({
    vector: qEmb,
    topK: 10,
    includeMetadata: true,
    filter: { regionId: 'generic' },
  });

  const [historyRes, pineRegionResp, pineGenericResp] =
    await Promise.all([historyPromise, pineRegionPromise, pineGenericPromise]);

  const history = historyRes.data.history || [];

  // prepare snippets
  const toSnippet = (m) => {
    const md = m?.metadata || {};
    const {
      sourcePdf = '<unknown source>',
      chunkIndex = '?',
      text = '<no text>',
      map= 'sa'
    } = md;
    return {
      sourcePdf: `${sourcePdf}`,
      id: `${map}:${sourcePdf}`,
      score: m?.score ?? 0,
      regionId: map,
      pretty: `(${map} | ${sourcePdf}, chunk #${chunkIndex}):\n${text}`
    };
  };

  let regionSnips = (pineRegionResp.matches || []).map(toSnippet);
  let genericSnips = (pineGenericResp.matches || []).map(toSnippet);

  const mentionsGeologist = /\bgeologist(s)?\b/i.test(question);

  // If user mentions "geologist", nudge generic snippets up a bit so they float higher.
  if (mentionsGeologist) {
    genericSnips = genericSnips.map(s => ({ ...s, score: s.score + 0.05 }));
  }

  // merge, dedupe by id, then sort by score desc; always include some of each
  const merged = [...regionSnips, ...genericSnips]
    .reduce((acc, s) => (acc.has(s.id) ? acc : acc.add(s.id) && acc), new Set(),)
    && [...regionSnips, ...genericSnips]; // Set trick above just for uniqueness
  const unique = Array.from(
    new Map([...regionSnips, ...genericSnips].map(s => [s.id, s])).values()
  ).sort((a, b) => (b.score - a.score));

  // keep a small, fast context
  const topSnips = unique.slice(0, 15);
  const contextEmpty = topSnips.length === 0;

  const contextBlock = topSnips.map(s => s.pretty).join('\n---\n');

  // Build a STRICT RAG developer message
  const devDirectives = [
    `You are an expert on regional geology in the area of South Africa. Region focus: ${regionId}.`,
    `Use the provided CONTEXT snippets as the **primary** source of truth.`,
    `Prefer the CONTEXT; if it does not contain relevant facts to answer, rely on your own knowledge to answer directly.`,
    `Be precise and avoid speculation. If you are uncertain, state the uncertainty briefly.`,
    `If the user text mentions "geologist", prefer the 'generic' snippets and explicitly attribute relevant statements as: "The geologist said …".`,
  ].join('\n');

  const ragContext = `${devDirectives}\n\nCONTEXT:\n${contextBlock || '<no context>'}`;

  const messages = [
    { role: 'developer', content: ragContext },
    ...history.slice(-12),
    { role: 'user', content: question }
  ];


  const chatResp = await openai.responses.create({
    model: 'gpt-4.1-nano-2025-04-14',
    input: messages
  });

  const assistantReply = chatResp.output_text;

  // respond ASAP
  res.json({ answer: assistantReply });

  // async logging (no await)
  axios.post(
    "https://x3kb-thkl-gi2q.n7e.xano.io/api:cWjxJO0v/llm_responses_save_sa",
    {
      prompt: question,
      session_id,
      response: assistantReply,
      metadata: {
        inputPrompts: [question],
        result: assistantReply,
        regionId,
        mentionsGeologist,
        usedContext: !contextEmpty,
        snippetCount: topSnips.length
      },
      regionId
    },
    { headers: { "Content-Type": "application/json" } }
  ).catch(err => console.error('save failed', err));
});


// Optional: Add a separate endpoint to check system status

const port = process.env.PORT || 3061;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

