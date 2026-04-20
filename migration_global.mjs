import admin from "firebase-admin";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

/* 🔥 FIREBASE INIT */
const serviceAccount = JSON.parse(
  fs.readFileSync("./firebase-key.json", "utf-8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

/* 🔥 LOAD JSON */
const rawData = JSON.parse(
  fs.readFileSync("./global_treatments.json", "utf-8")
);

/* 🚀 MIGRATION */
async function migrateGlobal() {
  console.log(`Total records: ${rawData.length}`);

  for (const item of rawData) {
    if (!item.symptom || !item.pathy) continue;

    const id =
      item.symptom.toLowerCase() +
      "_" +
      item.pathy.toLowerCase();

    await db.collection("global_treatments").doc(id).set({
      symptom: item.symptom.toLowerCase(),
      pathy: item.pathy.toLowerCase(),

      medicines: item.medicines || [],
      diet: item.diet || [],
      exercise: item.exercise || [],
      precautions: item.precautions || [],

      created_at: new Date(),
    });

    console.log(`✅ Added: ${id}`);
  }

  console.log("🔥 GLOBAL DATA IMPORT DONE");
}

/* ▶️ RUN */
migrateGlobal().then(() => process.exit());