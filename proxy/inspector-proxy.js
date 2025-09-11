// proxy-server.js
const express = require('express');
const axios = require('axios');
const app = express();

const cors = require('cors'); // n

const XSUAA_CLIENT_ID = 'sb-btp-sap-odata-to-mcp-server-development%21t110207';
const XSUAA_CLIENT_SECRET = '8572c292-d5c0-450f-93dc-5a3e13b50fc3$PTcJVavaivP8l5X4qYp7sZlc5zDb6bb6zOw1T9WpiXc=';
const XSUAA_TOKEN_URL = 'https://infrabel-app-dev.authentication.eu20.hana.ondemand.com/oauth/token';
// Enable CORS for the MCP inspector
app.use(cors({
  origin: 'http://localhost:6274', // MCP inspector URL
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Proxy endpoint for token exchange
app.post('/oauth/token', async (req, res) => {
    const params = new URLSearchParams({
            grant_type: 'authorization_code',
            code: req.body.code,
            client_id: req.body.client_id ,
            client_secret: XSUAA_CLIENT_SECRET,
            redirect_uri: req.body.redirect_uri
        });

        try {
            const response = await fetch(XSUAA_TOKEN_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                body: params.toString()
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
            }

            const tokenData = await response.json();
            res.json(tokenData);
        } catch (error) {
            this.logger.error('Failed to exchange code for token:', error);
            throw error;
        }
//   try {
//     // Add client credentials to the request
//     const tokenRequest = {
//       grant_type: req.body.grant_type,
//       code: req.body.code,
//       redirect_uri: req.body.redirect_uri,
//       client_id: XSUAA_CLIENT_ID,
//       client_secret: XSUAA_CLIENT_SECRET
//     };

//     const response = await axios.post(XSUAA_TOKEN_URL, 
//       new URLSearchParams(tokenRequest),
//       {
//         headers: {
//           'Content-Type': 'application/x-www-form-urlencoded'
//         }
//       }
//     );

//     res.json(response.data);
//   } catch (error) {
//     res.status(error.response?.status || 500).json(error.response?.data || { error: 'proxy_error' });
//   }
});

// Proxy the authorization endpoint
app.get('/oauth/authorize', (req, res) => {
const params = {
    client_id: req.query.client_id,
    redirect_uri: req.query.redirect_uri,
    response_type: 'code',
    state: req.query.state
};

  const authUrl = `https://infrabel-app-dev.authentication.eu20.hana.ondemand.com/oauth/authorize?${new URLSearchParams(params)}`;
  res.redirect(authUrl);
});

app.listen(8080, () => {
  console.log('OAuth proxy running on http://localhost:8080');
});