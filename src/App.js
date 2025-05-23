import express from "express";
import {getConfigVariable} from "./util.js";
import FireflyService from "./FireflyService.js";
import OpenAiService from "./OpenAiService.js";
import {Server} from "socket.io";
import * as http from "http";
import Queue from "queue";
import JobList from "./JobList.js";

export default class App {
    PORT;
    ENABLE_UI;

    firefly;
    openAi;

    server;
    io;
    express;

    queue;
    jobList;

    constructor() {
        this.PORT = getConfigVariable("PORT", '3000');
        this.ENABLE_UI = getConfigVariable("ENABLE_UI", 'false') === 'true';
    }

    async run() {
        this.firefly = new FireflyService();
        this.openAi = new OpenAiService();

        this.queue = new Queue({
            timeout: 30 * 1000,
            concurrency: 1,
            autostart: true
        });

        this.queue.addEventListener('start', job => console.log('Job started', job))
        this.queue.addEventListener('success', event => console.log('Job success', event.job))
        this.queue.addEventListener('error', event => console.error('Job error', event.job, event.err, event))
        this.queue.addEventListener('timeout', event => console.log('Job timeout', event.job))

        this.express = express();
        this.server = http.createServer(this.express)
        this.io = new Server(this.server)

        this.jobList = new JobList();
        this.jobList.on('job created', data => this.io.emit('job created', data));
        this.jobList.on('job updated', data => this.io.emit('job updated', data));

        this.express.use(express.json());

        if (this.ENABLE_UI) {
            this.express.use('/', express.static('public'))
        }

        this.express.post('/webhook', this.onWebhook.bind(this))

        this.server.listen(this.PORT, async () => {
            console.log(`Application running on port ${this.PORT}`);
        });

        this.io.on('connection', socket => {
            console.log('connected');
            socket.emit('jobs', Array.from(this.jobList.getJobs().values()));
        })
    }

    onWebhook(req, res) {
        try {
            console.info("Webhook triggered");
            this.handleWebhook(req, res);
            res.send("Queued");
        } catch (e) {
            console.error(e)
            res.status(400).send(e.message);
        }
    }

    handleWebhook(req, res) {
        // TODO: validate auth

        let message = "";

        if (req.body?.trigger !== "STORE_TRANSACTION") {
            message = "trigger is not STORE_TRANSACTION. Request will not be processed";
        }

        if (req.body?.response !== "TRANSACTIONS") {
            message = "response is not TRANSACTIONS. Request will not be processed";
        }

        if (!req.body?.content?.id) {
            message = "Missing content.id";
        }

        if (req.body?.content?.transactions?.length === 0) {
            message = "No transactions are available in content.transactions";
        }

        if (req.body.content.transactions[0].type !== "withdrawal") {
            message = "content.transactions[0].type has to be 'withdrawal'. Transaction will be ignored.";
        }

        if (req.body.content.transactions[0].category_id !== null) {
            message = "content.transactions[0].category_id is already set. Transaction will be ignored.";
        }

        if (!req.body.content.transactions[0].description) {
            message = "Missing content.transactions[0].description";
        }

        if (!req.body.content.transactions[0].destination_name) {
            message = "Missing content.transactions[0].destination_name";
        }

        
        const destinationName = req.body.content.transactions[0].destination_name;
        const description = req.body.content.transactions[0].description
        
        const job = this.jobList.createJob({
            destinationName,
            description
        }, message);

        if (message) {
            console.warn(message, req.body);
            return;
        }

        this.queue.push(async () => {
            this.jobList.setJobInProgress(job.id);

            const categories = await this.firefly.getCategories();

            const {category, prompt, response} = await this.openAi.classify(Array.from(categories.keys()), destinationName, description)

            const newData = Object.assign({}, job.data);
            newData.category = category;
            newData.prompt = prompt;
            newData.response = response;

            this.jobList.updateJobData(job.id, newData);

            if (category) {
                await this.firefly.setCategory(req.body.content.id, req.body.content.transactions, categories.get(category));
            }

            this.jobList.setJobFinished(job.id);
        });
    }
}
