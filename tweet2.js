const twitter = require('twitter');

var client = new twitter({
    consumer_key: consumer_key,
    consumer_secret: consumer_secret   , 
    access_token_key: access_token_key   ,
    access_token_secret:access_token_secret 
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
