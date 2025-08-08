//const config = require('../APIs/config/serverConfig.json')

const corsOptions = {
    origin: ["http://localhost:3000","https://enttlevo.online", "https://www.enttlevo.online", "https://chs-repo.vercel.app", "https://ch-hut-repo.vercel.app", "https://hopelessly-usable-stag.ngrok-free.app", "https://dear-moccasin-vastly.ngrok-free.app", "https://enabled-akita-highly.ngrok-free.app", "https://dev.enttlevo.online"],
    credentials: true,
    methods: ["GET", "POST", "PUT"],
};

module.exports = corsOptions;