const express = require('express');
const app = express();
const PORT = process.env.PORT;

app.get('/', (req, res) => res.send('Welcome to Unubo Cloud!'));

app.listen(PORT, () => console.log(`Ready on port`));
console.log("aaa");
