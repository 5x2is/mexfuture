'use strict';
//APIキーの読み込み
const crypto = require('crypto');
const fs = require('fs');
const keys = JSON.parse(fs.readFileSync('../keys/keyList.json'));
const webSocket = require('ws');
const request = require('request');
const key = keys.bitMex[0];
const secret = keys.bitMex[1];

const XBTMID ='XBTM20';
const XBTLNG ='XBTU20';

var MIDQty = 0;
var LNGQty = 0;
var errorFlag = false;
//ポジションを取得

runWebSocket();

function runWebSocket(){
	const connectionWS = new webSocket('wss://www.bitmex.com/realtime');
	connectionWS.onopen = (open)=>{
		console.log("WebSocketに接続");
		const timestamp = parseInt(Date.now()/1000+60);
		const sign = crypto.createHmac('sha256',secret).update('GET/realtime'+timestamp).digest('hex');
		const signup = JSON.stringify({
			op:"authKey",
			args:[key,timestamp,sign]
		});
		connectionWS.send(signup);
		connectionWS.send(JSON.stringify({op:"subscribe",args:['position']}));
	};
	connectionWS.onmessage= (dat)=>{
		if(!dat){
			return;
		}
		const message = JSON.parse(dat.data);
		switch(message.table){
			case "position":
				//long shortを比較
				//数が大きく離れていたら、差分だけ成行で決済
				check(message.data);
				break;
		}
	};
	connectionWS.onerror= (err)=>{
		console.log('error');
		console.log(JSON.parse(err));
	};
	connectionWS.onclose= ()=>{
		console.log('close');
		connectionWS.send(JSON.stringify({op:"subscribe",args:['position']}));
	};
}

function check(posDat){
	for(let i=0;i<posDat.length;i++){
		//console.log(posDat[i].symbol);
		//console.log(posDat[i].currentQty);

		if(posDat[i].symbol == XBTMID){
			MIDQty = posDat[i].currentQty;
		}else if(posDat[i].symbol == XBTLNG){
			LNGQty = posDat[i].currentQty;
		};
	}
	//差を計算
	let diff = MIDQty + LNGQty;	
	console.log('diff:'+diff);
	
	if(Math.abs(diff)>20){
		console.log('error!!!');
		errorFlag = errorFlag || parseInt(Date.now()/1000+60);		
		if(errorFlag -parseInt(Date.now()/1000+60) > 15*60){
			if(diff > 0){
				sendOrder(marketData(XBTLNG,"Sell",Math.abs(diff)));
			}else{
				sendOrder(marketData(XBTMID,"Buy",Math.abs(diff)));
			}
		}
	}else{
		errorFlag = false;
	}
	console.log(errorFlag);
}
function sendOrder(data){
	const verb = 'POST';
	const path = '/api/v1/order';
	const expires = Math.round(new Date().getTime() / 1000) + 60; // 1 min in the future
	const postBody = JSON.stringify(data);
	const signature = crypto.createHmac('sha256',secret).update(verb + path + expires + postBody).digest('hex');
	const headers = {
	  'content-type' : 'application/json',
	  'Accept': 'application/json',
	  'X-Requested-With': 'XMLHttpRequest',
	  'api-expires': expires,
	  'api-key': key,
	  'api-signature': signature
	};
	const requestOptions = {
		headers:headers,
		url:'https://www.bitmex.com'+path,
		method:verb,
		body:postBody	
	}
	//[task]エラーハンドリング
	request(requestOptions, (error,response,body)=>{
		if(error){
			console.log('エラー');
			console.log(error);
		}
	});
}
function marketData(symbol,side,orderQty){
	var data = {
		symbol:symbol,
		side:side,
		orderQty:orderQty,
		ordType:"Market",
	};
	return data;
}
