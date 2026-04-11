import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash";


// 🔥 SIMPLE DB FUNCTION
function searchDatabase(symptoms) {
  let medicines = [];

  const map = {
    fever: ["paracetamol"],
    headache: ["brufen"],
    anxiety: ["ignatia", "aconite"],
    "night sweats": ["silicea"],
  };

  symptoms.forEach((sym) => {
    const key = sym.toLowerCase();
    if (map[key]) {
      medicines.push(...map[key]);
    }
  });

  return {
    medicines: [...new Set(medicines)],
  };
}


// 🚀 MAIN API
app.post("/analyze", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `
You are a STRICT JSON medical assistant.

Extract symptoms and medicines.

Text: ${text}

ONLY return valid JSON. No explanation.

{
  "symptoms": [],
  "medicines": []
}
                `,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
        },
      }),
    });

    const data = await response.json();

    let aiText =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // 🔥 CLEAN RESPONSE
    aiText = aiText
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    // 🔥 JSON EXTRACT
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return res.json({
        source: "gemini_raw",
        raw: aiText,
      });
    }

    let aiResponse;

    try {
      aiResponse = JSON.parse(jsonMatch[0]);
    } catch (err) {
      return res.json({
        source: "gemini_parse_error",
        raw: aiText,
      });
    }

    // 🔥 DB SEARCH
    const dbResult = searchDatabase(aiResponse.symptoms || []);

    let finalMedicines = aiResponse.medicines || [];
    let source = "gemini";

    // 👉 HYBRID LOGIC
    if (!finalMedicines || finalMedicines.length === 0) {
      finalMedicines = dbResult.medicines;
      source = "ai+database";
    } else {
      finalMedicines = [
        ...new Set([...finalMedicines, ...dbResult.medicines]),
      ];
      source = "gemini+database";
    }

    // 🔥 FINAL RESPONSE (DEBUG + RESULT)
    return res.json({
      source,
      input: text,

      debug: {
        ai_raw_text: aiText,
        ai_response: aiResponse,
        db_result: dbResult,
      },

      final: {
        symptoms: aiResponse.symptoms || [],
        medicines: finalMedicines,
      },
    });

  } catch (error) {
    res.status(500).json({
      error: "Server Error",
      msg: error.message,
    });
  }
});


// 🔥 SERVER START
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});