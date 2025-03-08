import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors());

// Route to fetch cloud data
app.get('/clouds', async (req, res) => {
  const time = req.query.time || new Date().toISOString().split('.')[0] + 'Z';
  const tileMatrix = req.query.tileMatrix || '1';
  const tileCol = req.query.tileCol || '0';
  const tileRow = req.query.tileRow || '0';
  
  try {
    const response = await axios({
      method: 'get',
      url: `https://gibs-b.earthdata.nasa.gov/wmts/epsg4326/best/wmts.cgi`,
      params: {
        TIME: time,
        layer: 'VIIRS_NOAA20_Clear_Sky_Confidence_Day',
        style: 'default',
        tilematrixset: '1km',
        Service: 'WMTS',
        Request: 'GetTile',
        Version: '1.0.0',
        Format: 'image/png',
        TileMatrix: tileMatrix,
        TileCol: tileCol,
        TileRow: tileRow
      },
      responseType: 'arraybuffer'
    });
    
    res.set('Content-Type', 'image/png');
    res.send(response.data);
  } catch (error) {
    console.error('Error fetching cloud data:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
    }
    res.status(500).send('Error fetching cloud data');
  }
});

// Simple health check endpoint
app.get('/', (req, res) => {
  res.send('Cloud Proxy Server is running');
});

app.listen(port, () => {
  console.log(`Proxy server running on port ${port}`);
});