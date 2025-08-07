require('dotenv').config();
const express = require('express');
require('dotenv').config();
const axios = require('axios');
const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');


const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
});
const index = pinecone.Index('pdf-chunks-poc');

// 2) Init OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
app.use(express.json());

app.post('/chat', async (req, res) => {
  try {
    const { regionId, question, session_id } = req.body;
    if (!regionId || !question) {
      return res.status(400).json({ error: 'regionId and question are required' });
    }

    // 3) Embed the question
    const embResp = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: question,
    });
    const qEmb = embResp.data[0].embedding;

    // // 4) Pinecone similarity query with metadata filter
    const pineResp = await index.query({
      vector: qEmb,
      topK: 5,
      includeMetadata: true,
      filter: { regionId },
    });

    // 5) Build snippets
    const snippets = pineResp.matches.length
      ? pineResp.matches.map(m => {
        const { sourcePdf, chunkIndex, text = '<no text>' } = m.metadata;
        return `(${sourcePdf}, chunk #${chunkIndex}):\n${text}`;
      })
      : [];

    // 6) Retrieve chat history
    // const snippets = []
    const historyRes = await axios.post(
      'https://x3kb-thkl-gi2q.n7e.xano.io/api:hWPNd5f8/get_history',
      { session_id, message: question },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const history = historyRes.data.history;

    // 7) Construct RAG context
    const ragContext =
      `You are an expert on regional geology. Answer using the following context snippets: as increased knowledge, But if context is empty, use your own knowledge\n\n` +
      `CONTEXT:\n${snippets.join('\n---\n')}`;

    const messages = [
      { role: 'system', content: ragContext },
      ...history
    ];

    // 8) Call GPT-4
    const chatResp = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
      temperature: 0,
    });

    const assistantReply = chatResp.choices[0].message.content.trim();


    await axios.post(
      "https://x3kb-thkl-gi2q.n7e.xano.io/api:hWPNd5f8/llm_responses_save",
      {
        prompt: question,
        session_id: session_id,
        response: assistantReply,
        metadata: {
          inputPrompts: [question],
          result: assistantReply
        },
        regionId: regionId
      },
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    // const newHistory = [
    //   ...history,
    //   { role: 'user', content: question },
    //   { role: 'assistant', content: assistantReply },
    // ];

    res.json({ answer: assistantReply});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const port = process.env.PORT || 3055;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

