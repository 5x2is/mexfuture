const twitter = require('twitter');
const fs = require('fs');
//const keys = JSON.parse(fs.readFileSync('../keys/keyList.json'));
const Tkeys = JSON.parse(process.env['SECRETS']);

var client = new twitter({
    consumer_key:        Tkeys.twitter[0],
    consumer_secret:     Tkeys.twitter[1],
    access_token_key:    Tkeys.twitter[2],
    access_token_secret: Tkeys.twitter[3],
});

exports.tweet=async(text)=>{
	//同じツイートがエラーになるの対策で日付を入れる。
	const date = new Date().toLocaleString();
	text = date +'\n'+text;
	client.post('statuses/update', {status: text},function(error, tweet, response) {
	    if (!error) {
	        console.log('Tweet完了')
	    }else{
			console.log(error);
		}
	});
}
