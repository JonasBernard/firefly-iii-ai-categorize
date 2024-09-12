import App from "./src/App.js";
import dotenv from "dotenv";

(async function () {
    dotenv.config();

    const app = new App();
    await app.run();
})();