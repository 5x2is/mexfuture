const twitter = require('twitter');
const keys = JSON.loads(process.env.['SECRETS']);

var client = new twitter({
    consumer_key:        keys.twitter[0],
    consumer_secret:     keys.twitter[1],
    access_token_key:    keys.twitter[2],
    access_token_secret: keys.twitter[3],
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
