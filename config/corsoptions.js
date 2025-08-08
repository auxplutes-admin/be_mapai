//const config = require('../APIs/config/serverConfig.json')

const corsOptions = {
    origin: ["http://localhost:3000", "http://localhost:3001", "https://mapai.enttlevo.online"],
    credentials: true,
    methods: ["GET", "POST", "PUT"],
};

module.exports = corsOptions;