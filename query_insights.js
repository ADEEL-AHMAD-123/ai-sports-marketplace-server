const { MongoClient } = require('mongodb');

const MONGO_URI = "mongodb+srv://peter:peter123@cluster0.iv1zzj3.mongodb.net/ai_sports_marketplace?retryWrites=true&w=majority&appName=Cluster0";

async function queryInsights() {
  const client = new MongoClient(MONGO_URI);
  
  try {
    await client.connect();
    const db = client.db('ai_sports_marketplace');
    const insights = db.collection('insights');
    
    console.log('\n========== JARED JONES - STRIKEOUTS ==========\n');
    const jaredJones = await insights.findOne({ 
      playerName: 'Jared Jones',
      statType: 'strikeouts'
    });
    
    if (jaredJones) {
      console.log(JSON.stringify(jaredJones, null, 2));
    } else {
      console.log('No document found for Jared Jones - strikeouts');
    }
    
    console.log('\n========== BRYCE HARPER - HITS ==========\n');
    const brycyceHarper = await insights.findOne({ 
      playerName: 'Bryce Harper',
      statType: 'hits'
    });
    
    if (brycyceHarper) {
      console.log(JSON.stringify(brycyceHarper, null, 2));
    } else {
      console.log('No document found for Bryce Harper - hits');
    }
    
  } finally {
    await client.close();
  }
}

queryInsights().catch(console.error);
