const { MongoClient } = require('mongodb');

const MONGO_URI = "mongodb+srv://peter:peter123@cluster0.iv1zzj3.mongodb.net/ai_sports_marketplace?retryWrites=true&w=majority&appName=Cluster0";

async function queryInsights() {
  const client = new MongoClient(MONGO_URI);
  
  try {
    await client.connect();
    const db = client.db('ai_sports_marketplace');
    const insights = db.collection('insights');
    
    console.log('=== Searching for Jared Jones documents ===\n');
    const results = await insights.find({ 
      playerName: { $regex: 'Jared', $options: 'i' }
    }).toArray();
    
    console.log(`Found ${results.length} documents matching "Jared"`);
    results.forEach(doc => {
      console.log(`\n${doc.playerName} - ${doc.statType}`);
    });
    
  } finally {
    await client.close();
  }
}

queryInsights().catch(console.error);
