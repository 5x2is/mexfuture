'use strict';
//サーバ関係
const express = require('express');
const app = express();
const http = require('http').Server(app);
const PORT = process.env.PORT || 4000;
const io = require('socket.io')(http);
//DB関係
const mariadb = require('mariadb');
const keys = JSON.parse(process.env['MARIA']);
const pool = mariadb.createPool({
	host:keys.mariadb[0],
	user:'root',
	password:keys.mariadb[1],
	port:3306,
	database:'my_database'
});

const crypto = require('crypto');
const fs = require('fs');
//const keys = JSON.parse(fs.readFileSync('../keys/keyList.json'));
const keys = JSON.parse(process.env['MEX']);
const webSocket = require('ws');
const request = require('request');
const twitter = require('./tweet.js');
//APIキーの読み込み
const key = keys.bitMex[0];
const secret = keys.bitMex[1];

//Symbolの設定
const XBTMID ='XBTM20';
const XBTLNG ='XBTU20';
const MID = 'M20';
const LNG = 'U20';
const clID = {M20:'MID',U20:'LNG'};
//最新情報格納用変数
var price = {//askが売り板(高い方)
	LNGask:0,
	LNGbid:0,
	MIDask:0,
	MIDbid:0
}//板の最上位価格
//初期化完了フラグ
var init_flag;
//エラー用
var mexError = {
	XBTLNGLimit:false,	
	XBTLNGStop:false,	
	XBTMIDLimit:false,	
	XBTMIDStop:false
};
//差額
var openDiff;
var closeDiff;
//最大レバ
var maxLeverage;
//1回あたりの発注
var orderAmount;
//現在のレバレッジ
var currentLeverage;
//ブロッカー
//発注中フラグ
var ordFlag = false;
var ordNo = -1;
//orderCheck中の再発注用
var orderDirection;
//ポジションリスト
//{オープン閾値,オープン価格,クローズ閾値,ポジション量,成行or指値(buy側),成行or指値(sell側)}
var positions = [];
//openとcloseの差額設定
var profitTarget;
//orderList
var LNGLimitOrder;
var LNGStopOrder;
var MIDLimitOrder;
var MIDStopOrder;

//positionsの中身のobj
const posObj = {
	openLimit :false,
	openPrice :false,
	closeLimit :false,
	closePrice :false,
	LNGamount :false,
	MIDamount :false,
	openLNGFee :false,
	closeLNGFee :false,
	openMIDFee :false,
	closeMIDFee :false,
	LNGopenPrice :false,
	LNGclosePrice :false,
	MIDopenPrice :false,
	MIDclosePrice :false,
	profit :false
};

//positionsクラス
class Position {
	constructor(posDat){
		for(let key in posDat){
			this[key] = posDat[key];
		}
	}
	setProfit(){
		this.profit = 
			this.LNGamount*(
			(1-this.openLNGFee)/this.LNGopenPrice -
			(1+this.closeLNGFee)/this.LNGclosePrice) +
			this.MIDamount*(
			(1-this.closeMIDFee)/this.MIDclosePrice -
			(1+this.openMIDFee)/this.MIDopenPrice);
	}	
	setOpenPrice(){
		this.openPrice = (this.MIDopenPrice - this.LNGopenPrice)*(-1);
	}
	setClosePrice(){
		this.closePrice = (this.MIDclosePrice - this.LNGclosePrice)*(-1);
	}
	setCloseLimit(){
		this.closeLimit = Math.floor(this.openPrice + profitTarget 
				+ this.openLNGFee * this.LNGopenPrice 
				+ this.openMIDFee * this.MIDopenPrice);
	}
}
//class化
class OrderList{
	constructor(){
		this.nonce = false;
		this.stat = false;
		this.target = "open";
		this.partialExec = false;
	}
	//[task]target値の変更のメソッド化
}
function initOrderList(){
	LNGLimitOrder = new OrderList();
	LNGStopOrder = new OrderList();
	MIDLimitOrder = new OrderList();
	MIDStopOrder = new OrderList();
}
//ここから開始
init();
const checkInterval = setInterval(checkStat,1000);

function init(){
	//パラメータの読み込み
	//syncで読み込み
	maxLeverage = 10;
	orderAmount = 0.02;
	initOrderList();
	profitTarget = 40;
	//DBからpositionsにコピー
	const rows = rowDatabase();
	const length = rows.length;
	for(let i = 0; i<length;i++){
		positions[i] =  new Position(rows[i]);
	}
	init_flag = {
		all:false,
		XBTLNG:false,
		XBTMID:false,
		margin:false,
		order:false
	}
	runWebSocket();
}
//MariaDBの読み込み
async function rowDatabase(){
	let conn;
	let rows; 
	try{
		conn = await pool.getConnection();
		//テーブル全体を取得
		rows = await conn.query('select * from positions');
		wsLog(rows[0].openLimit);
	}catch(err){
		wsLog(err);
	}finally{
		if(conn){
			conn.end();
			return rows;
		}
	}
}
var diffHis = {open:[],close:[]};
function checkStat(){
	if(ordFlag){
		return;
	}	
	if(!init_flag.all){
		return;
	}
	let stat = [false,false];
	diffHis.open.push(openDiff);
	if(diffHis.open.length > 30){
		diffHis.open.shift();
		if(Math.max.apply(null,diffHis.open)-Math.min.apply(null,diffHis.open) < 5){
			stat[0] = true;
		}
	}
	diffHis.close.push(closeDiff);
	if(diffHis.close.length > 30){
		diffHis.close.shift();
		if(Math.max.apply(null,diffHis.close)-Math.min.apply(null,diffHis.close) < 5){
			stat[1] = true;
		}
	}
	if(stat[0] && stat[1]){
		check();
	}	
}
//record Objectを作成
function isExistFile(title){
	try{
		fs.statSync(title);
		return true;
	}catch(err){
		if(err.code === 'ENOENT'){
			return false;
		}
	}
}
function runWebSocket(){
	const connectionWS = new webSocket('wss://www.bitmex.com/realtime');
	connectionWS.onopen = (open)=>{
		wsLog("WebSocketに接続");
		const timestamp = parseInt(Date.now()/1000+60);
		const sign = crypto.createHmac('sha256',secret).update('GET/realtime'+timestamp).digest('hex');
		const signup = JSON.stringify({
			op:"authKey",
			args:[
				key,
				timestamp,
				sign
			]
		});
		connectionWS.send(signup);
		connectionWS.send(JSON.stringify({op:"subscribe",args:['margin']}));
		//connectionWS.send(JSON.stringify({op:"subscribe",args:['position']}));
		connectionWS.send(JSON.stringify({op:"subscribe",args:['order']}));
		connectionWS.send(JSON.stringify({op:"subscribe",args:['instrument:'+XBTLNG]}));
		connectionWS.send(JSON.stringify({op:"subscribe",args:['instrument:'+XBTMID]}));
	};
	connectionWS.onmessage= (dat)=>{
		if(!dat){
			return;
		}
		const message = JSON.parse(dat.data);
		switch(message.table){
			case "margin":
				currentLeverage = message.data[0].marginLeverage ||  currentLeverage; 
				init_flag.margin = true;
				break;
			case "position":
				//wsLog("potision");
				//wsLog(message.data);
				//init_flag[5] = true;
				break;
			case "order":
				//ポジションの照合
				message.data.forEach((element)=>{
				//	wsLog(element);
				});
				//売買中フラグ立ってたら、売買モードに行く
				if(ordFlag){
					orderChecker(message.data);
				}
				init_flag.order= true;
				break;
			case "instrument":
				if(!message.data[0].midPrice){
					break;
				}
				switch(message.data[0].symbol){
					case XBTLNG:
						price.LNGask = message.data[0].askPrice || price.LNGask;
						price.LNGbid = message.data[0].bidPrice || price.LNGbid;
						init_flag.XBTLNG= true;
						break;
					case XBTMID:
						price.MIDask = message.data[0].askPrice || price.MIDask;	
						price.MIDbid = message.data[0].bidPrice || price.MIDbid;
						init_flag.XBTMID= true;
						break;
				}
				//売買判定
				openDiff = price.LNGask - price.MIDbid;
				closeDiff = price.LNGbid - price.MIDask; 
				//初期化完了しているか、完了して無かったらチェック
				if(!init_flag.all){
					if(
						init_flag.XBTLNG &&
						init_flag.XBTMID &&
						init_flag.margin &&
						init_flag.order
					){
						init_flag.all = true;
					}else{
						break;
					}
				};
				if(ordFlag){
					break;
				}	
				//record.price();
				tweetStat();
				break;
		}
	};
	connectionWS.onerror= (err)=>{
		wsLog('error');
		wsLog(JSON.parse(err));
	};
	connectionWS.onclose= ()=>{
		//[task]closeした時の処置
		wsLog('close');
		//[task]全部closeしてから再起動
		connectionWS.send(JSON.stringify({op:"unsubscribe",args:['margin']}));
		connectionWS.send(JSON.stringify({op:"unsubscribe",args:['order']}));
		connectionWS.send(JSON.stringify({op:"unsubscribe",args:['instrument:'+XBTLNG]}));
		connectionWS.send(JSON.stringify({op:"unsubscribe",args:['instrument:'+XBTMID]}));
		setTimeout(init,30000);
	};
}
var lastLog = 0;
function check(){
	const date = new Date();
	if(openDiff != lastLog){
		wsLog(date.getMinutes()+' open:'+openDiff+' close:'+closeDiff);
		lastLog = openDiff;
	}
	const orderNonce = ''+date.getMinutes()+date.getSeconds();
	//閾値より大きいか
	for(let i = 0;i<positions.length;i++){
		if(positions[i].closeLimit){
			if(closeDiff > positions[i].closeLimit){
				wsLog("ポジションクローズ"+date);
				//LNG指値売り
				sendOrder(limitData(LNG,"Sell",positions[i].LNGamount,price.LNGask,orderNonce));
				LNGLimitOrder.nonce = orderNonce;
				positions[i].LNGclosePrice = price.LNGask;
				//LNGストップ成行売り
				sendOrder(stopData(LNG,"Sell",positions[i].LNGamount,price.LNGbid-0.5,orderNonce));
				LNGStopOrder.nonce = orderNonce;
				//MID指値買い
				sendOrder(limitData(MID,"Buy",positions[i].MIDamount,price.MIDbid,orderNonce));
				MIDLimitOrder.nonce = orderNonce;
				positions[i].MIDclosePrice = price.MIDbid;
				//MIDストップ成行買い
				sendOrder(stopData(MID,"Buy",positions[i].MIDamount,price.MIDask+0.5,orderNonce));
				MIDStopOrder.nonce = orderNonce;
				//フラグ建てる
				ordFlag = true;
				ordNo = i;
				orderDirection = "close";
				break;	
			}	
		}else{
			if(openDiff < positions[i].openLimit){
				//証拠金の余力があるか
					if(currentLeverage > maxLeverage){
						break;	
						}		
				wsLog("ポジションオープン"+date);
				//LNG買い
				sendOrder(limitData(LNG,"Buy",Math.round(orderAmount*price.LNGbid),price.LNGbid,orderNonce));
				LNGLimitOrder.nonce = orderNonce;
				positions[i].LNGopenPrice = price.LNGbid;
				sendOrder(stopData(LNG,"Buy",Math.round(orderAmount*price.LNGask+0.5),price.LNGask+0.5,orderNonce));
				LNGStopOrder.nonce = orderNonce;
				//MID売り
				sendOrder(limitData(MID,"Sell",Math.round(orderAmount*price.MIDask),price.MIDask,orderNonce));
				MIDLimitOrder.nonce = orderNonce;
				positions[i].MIDopenPrice = price.MIDask;
				sendOrder(stopData(MID,"Sell",Math.round(orderAmount*price.MIDbid-0.5),price.MIDbid-0.5,orderNonce));
				MIDStopOrder.nonce = orderNonce;
				//フラグ建てる
				ordFlag = true;
				ordNo = i;
				orderDirection = "open";
				break;	
			}	
		}	
	}
}
const record = {
	price(){
		const filetitle = "./dif_log/"+this.date()+".csv";
		//[task]1行目を作成
		const dat = 
			this.time() + ','+
			price.LNGask + ','+
			price.LNGbid + ','+
			price.MIDask + ','+
			price.MIDbid + ','+
			openDiff + ','+ 
			closeDiff + ','+ '\n';
		this.add(filetitle,dat);
	},
	trade(result){
		const filetitle = "./result/"+this.date()+".csv";
		const dat = 
			this.time() + ','+
			result.openLimit + ','+
			result.LNGopenPrice + ','+
			result.openLNGFee + ','+
			result.MIDopenPrice + ','+
			result.openPrice + ','+
			result.closeLimit + ','+
			result.LNGclosePrice + ','+
			result.closeLNGFee + ','+
			result.MIDclosePrice + ','+
			result.closeMIDFee + ','+
			result.closePrice + ','+
			result.LNGamount + ','+
			result.MIDamount + ','+
			result.profit + ','+ '\n';
		this.add(filetitle,dat);
	},
	date(){
		const date = new Date();
		return date.getFullYear()+"_"+(date.getMonth()+1)+"_"+date.getDate();
	},
	time(){
		const date = new Date();
		return date.getHours()+':'+date.getMinutes()+':'+date.getSeconds();
	},
	add(filetitle,dat){
		fs.appendFile(filetitle,dat,(err)=>{
			if(err){
				wsLog(err);
			}else{
				return;
			}
		}); 
	},
	overWrite(filetitle,dat){
		fs.writeFile(filetitle,dat,(err)=>{
			if(err){
				wsLog(err);
			}else{
				return;
			}
		}); 
	}
}; 
//クラス化
function orderChecker(orders){
	const date = new Date();
	const orderNonce = ''+date.getMinutes()+date.getSeconds();
	orders.forEach((element)=>{
		//wsLog(element);
		switch(element.clOrdID){
			//closeの場合とopenの場合
			case"LNGLimit"+LNGLimitOrder.nonce:
				//最初はここに入る
				switch(LNGLimitOrder.target){
					case "open":
						if(element.workingIndicator== true){
							wsLog("LNGLimit発注成功");	
							LNGLimitOrder.target= "fill";
						}else if(element.ordStatus == "Canceled"){
							wsLog("LNGLimit発注失敗");
							//発注失敗した場合、再発注
							if(orderDirection == "open"){
								if(positions[ordNo].LNGopenPrice == price.LNGbid){
									sendOrder(limitData(LNG,"Buy",Math.round(orderAmount*price.LNGbid),price.LNGbid-0.5,orderNonce));
									positions[ordNo].LNGopenPrice = price.LNGbid-0.5;
								}else{
									sendOrder(limitData(LNG,"Buy",Math.round(orderAmount*price.LNGbid),price.LNGbid,orderNonce));
									positions[ordNo].LNGopenPrice = price.LNGbid;
								}
								LNGLimitOrder.nonce = orderNonce;
								wsLog(price.LNGbid+"でLNGLimit再発注");
							}else if(orderDirection == "close"){
								if(positions[ordNo].LNGclosePrice == price.LNGask){
									sendOrder(limitData(LNG,"Sell",positions[ordNo].LNGamount,price.LNGask+0.5,orderNonce));
									positions[ordNo].LNGclosePrice = price.LNGask+0.5;
								}else{
									sendOrder(limitData(LNG,"Sell",positions[ordNo].LNGamount,price.LNGask+0.5,orderNonce));
									positions[ordNo].LNGclosePrice = price.LNGask;
								}
								LNGLimitOrder.nonce = orderNonce;
								wsLog(price.LNGask+"でLNGLimit再発注");
							}
						}
						break;
					case "fill":
						//約定した場合
						if(element.ordStatus == "Filled"){
							wsLog("LNGLimit約定");	
							LNGLimitOrder.stat = true;
							if(orderDirection == "open"){
								wsLog(element);
								positions[ordNo].openLNGFee = -0.00025;
								positions[ordNo].LNGamount = element.cumQty;//書かない
							}else if(orderDirection == "close"){
								positions[ordNo].closeLNGFee = -0.00025;
							}
							//LNGStopをキャンセル	
							if(mexError.LNGLimit){
								//[task]ここ修正
								LNGStopOrder.target = "true";
							}else{
								LNGStopOrder.target = "cancel";
								cancelOrder("LNGStop"+LNGStopOrder.nonce);
							}
						}
						if(element.leavesQty != 0){
							//部分約定した場合
							wsLog("LNGLimit 部分約定");
							//合計約定amount
							LNGLimitOrder.partialExec = element.leavesQty ;
						}
						break;
					case "cancel":
						//キャンセルが通った場合
						if(element.ordStatus == "Canceled"){
							if(LNGLimitOrder.partialExec){
								wsLog("部分約定あり、LNG反対決済");
								if(orderDirection == "open"){
									sendOrder(marketData(LNG,"Sell",LNGLimitOrder.partialExec ,"LNGLimit"+orderNonce));
								}else if(orderDirection == "close"){
									sendOrder(marketData(LNG,"Buy",LNGLimitOrder.partialExec ,"LNGLimit"+orderNonce));
								}
								LNGLimitOrder.target= "forceCancel";
								LNGLimitOrder.nonce = orderNonce;
							}else{
								wsLog("LNGLimitキャンセル");	
								LNGLimitOrder.stat = true;
							}
						}else if(element.ordStatus == "Filled"){
							//約定してしまった場合
							wsLog("filled!!!");
							//強制反対注文
							//[task] 両方反対注文が入らないようにする
							if(orderDirection == "open"){
								sendOrder(marketData(LNG,"Sell",positions[ordNo].LNGamount,"LNGLimit"+orderNonce));
							}else if(orderDirection == "close"){
								sendOrder(marketData(LNG,"Buy",positions[ordNo].LNGamount,"LNGLimit"+orderNonce));
							}
							LNGLimitOrder.nonce = orderNonce;
							LNGLimitOrder.target= "forceCancel";
						}
						break;
					case "forceCancel":
						//強制キャンセルの確認
						if(element.ordStatus == "Filled"){
							wsLog('LNGLimit強制キャンセル成功');	
							LNGLimitOrder.stat = true;
						}
						break;
				}
				break;
			case"LNGStop"+LNGStopOrder.nonce:
				switch(LNGStopOrder.target){
					case "open":
						wsLog("LNGStop発注成功");	
						LNGStopOrder.target= "fill";
						break;
					case "fill":
						//約定した場合
						if(element.ordStatus == "Filled"){
							wsLog("LNGStop約定");	
							LNGStopOrder.stat = true;
							if(orderDirection == "open"){
								positions[ordNo].LNGopenPrice= element.avgPx; 
								positions[ordNo].openLNGFee = 0.000675;
								positions[ordNo].LNGamount = element.cumQty;
							}else if(orderDirection == "close"){
								positions[ordNo].LNGclosePrice= element.avgPx; 
								positions[ordNo].closeLNGFee = 0.000675;
							}
							//LNGLimitをキャンセル	
							if(mexError.LNGStop){
								LNGLimitOrder.target = true;
							}else{
								LNGLimitOrder.target = "cancel";
								cancelOrder("LNGLimit"+LNGLimitOrder.nonce);
							}
						}
						break;
					case "cancel":
						//キャンセルが通った場合
						if(element.ordStatus == "Canceled"){
							wsLog("LNGStopキャンセル");	
							LNGStopOrder.stat = true;
						}else if(element.ordStatus == "Filled"){
							//約定してしまった場合
							wsLog("filled!!!");
							//強制反対注文
							//[task] 両方反対注文が入らないようにする
						}
						break;
				}
				break;
			case"MIDLimit"+MIDLimitOrder.nonce:
				switch(MIDLimitOrder.target){
					case "open":
						if(element.workingIndicator== true){
							wsLog("MIDLimit発注成功");	
							MIDLimitOrder.target= "fill";
						}else if(element.ordStatus == "Canceled"){
							wsLog("MID発注失敗");
							//発注失敗した場合、再発注
							if(orderDirection == "open"){
								if(positions[ordNo].MIDopenPrice == price.MIDask){
									sendOrder(limitData(MID,"Sell",Math.round(orderAmount*price.MIDask),price.MIDask+0.5,orderNonce));
									positions[ordNo].MIDopenPrice = price.MIDask+0.5;
								}else{
									sendOrder(limitData(MID,"Sell",Math.round(orderAmount*price.MIDask),price.MIDask,orderNonce));
									positions[ordNo].MIDopenPrice = price.MIDask;
								}
								positions[ordNo].MIDopenPrice = price.MIDask;
								MIDLimitOrder.nonce = orderNonce;
								wsLog(price.MIDask+"で再発注");
							}else if(orderDirection == "close"){
								if(positions[ordNo].MIDclosePrice == price.MIDbid){
									sendOrder(limitData(MID,"Buy",positions[ordNo].MIDamount,price.MIDbid-0.5,orderNonce));
									positions[ordNo].MIDclosePrice = price.MIDbid-0.5;
								}else{
									sendOrder(limitData(MID,"Buy",positions[ordNo].MIDamount,price.MIDbid,orderNonce));
									positions[ordNo].MIDclosePrice = price.MIDbid;
								}
								MIDLimitOrder.nonce = orderNonce;
								wsLog(price.MIDbid+"で再発注");
							}
						}
						break;
					case "fill":
						//約定した場合
						if(element.ordStatus == "Filled"){
							wsLog("MIDLimit約定");	
							MIDLimitOrder.stat = true;
							if(orderDirection == "open"){
								positions[ordNo].openMIDFee = -0.00025;
								positions[ordNo].MIDamount = element.cumQty;
							}else if(orderDirection == "close"){
								positions[ordNo].closeMIDFee = -0.00025;
							}
							//MIDStopをキャンセル
							if(mexError.MIDLimit){
								MIDStopOrder.target = true;
							}else{
								MIDStopOrder.target = "cancel";
								cancelOrder("MIDStop"+MIDStopOrder.nonce);
							}
						}
						if(element.leavesQty != 0){
							//部分約定した場合
							wsLog("MIDLimit 部分約定");
							//合計約定amount
							MIDLimitOrder.partialExec = element.leavesQty ;
						}
						break;
					case "cancel":
						//キャンセルが通った場合
						if(element.ordStatus == "Canceled"){
							if(MIDLimitOrder.partialExec){
								wsLog("部分約定あり、MID反対決済");
								if(orderDirection == "open"){
									sendOrder(marketData(MID,"Buy",MIDLimitOrder.partialExec,"MIDLimit"+orderNonce));
								}else if(orderDirection == "close"){
									sendOrder(marketData(MID,"Sell",MIDLimitOrder.partialExec,"MIDLimit"+orderNonce));
								}
								MIDLimitOrder.nonce = orderNonce;
								MIDLimitOrder.target= "forceCancel";
							}else{
								wsLog("MIDLimitキャンセル");	
								MIDLimitOrder.stat = true;
							}
						}else if(element.ordStatus == "Filled"){
							//約定してしまった場合
							//[task]部分約定
							wsLog("MIDfilled!!!");
							//強制キャンセル
							if(orderDirection == "open"){
								sendOrder(marketData(MID,"Buy",positions[ordNo].MIDamount,"MIDLimit"+orderNonce));
							}else if(orderDirection == "close"){
								sendOrder(marketData(MID,"Sell",positions[ordNo].MIDamount,"MIDLimit"+orderNonce));
							}
							MIDLimitOrder.nonce = orderNonce;
							MIDLimitOrder.target= "forceCancel";
						}
						break;
					case "forceCancel":
						//強制キャンセルの確認
						if(element.ordStatus == "Filled"){
							wsLog('MIDLimit強制キャンセル成功');	
							MIDLimitOrder.stat = true;
						}
						break;
				}
				break;
			case"MIDStop"+MIDStopOrder.nonce:
				switch(MIDStopOrder.target){
					case "open":
						wsLog("MIDStop発注成功");	
						MIDStopOrder.target= "fill";
						break;
					case "fill":
						//約定した場合
						if(element.ordStatus == "Filled"){
							wsLog("MIDStop約定");	
							MIDStopOrder.stat = true;
							if(orderDirection == "open"){
								positions[ordNo].MIDopenPrice= element.avgPx; 
								positions[ordNo].openMIDFee= 0.000675;
								positions[ordNo].MIDamount = element.cumQty;
							}else if(orderDirection == "close"){
								positions[ordNo].MIDclosePrice= element.avgPx; 
								positions[ordNo].closeMIDFee= 0.000675;
							}
							//MIDLimitをキャンセル	
							if(mexError.MIDStop){
								MIDLimitOrder.target = true;
							}else{
								MIDLimitOrder.target = "cancel";
								cancelOrder("MIDLimit"+MIDLimitOrder.nonce);
							}
						}
						break;
					case "cancel":
						//キャンセルが通った場合
						if(element.ordStatus == "Canceled"){
							wsLog("MIDStopキャンセル");	
							MIDStopOrder.stat = true;
						}else if(element.ordStatus == "Filled"){
							//約定してしまった場合
							wsLog("filled!!!");
						}
						break;
				}
				break;
		}
	});
	orderFinishProc();
}
function orderFinishProc(){
	if(ordFlag === false){
		return;
	}
	//全部trueになったら終了
	if(LNGLimitOrder.stat && LNGStopOrder.stat && MIDLimitOrder.stat && MIDStopOrder.stat){
		ordFlag = false;
		wsLog('発注完了!!');
	}
	//[task]forcecloseした時の計算
	if(ordFlag == false){
		if(orderDirection == "open"){
			positions[ordNo].setOpenPrice();
			positions[ordNo].setCloseLimit();
			wsLog(positions[ordNo]);
			//結果保存
			//record.trade(positions[ordNo]);	
			//ツイート
			tweetTrade(positions[ordNo]);
		}else if(orderDirection == "close"){
			positions[ordNo].setClosePrice();
			positions[ordNo].setProfit(); 
			wsLog(positions[ordNo]);
			//結果保存
		//	record.trade(positions[ordNo]);	
			//ツイート
			tweetTrade(positions[ordNo]);
			//クローズしたらposition削除
			posObj.openLimit = positions[ordNo].openLimit;
			positions[ordNo] = new Position(posObj);
		}
		//mexError初期化
		mexError = {
			XBTLNGLimit:false,	
			XBTLNGStop:false,	
			XBTMIDLimit:false,	
			XBTMIDStop:false
		};
		//orderList初期化
		initOrderList();
		//positionリスト保存
		recordPosition();	
		ordNo = -1;
	}
}
async function recordPosition(){
	let conn;
	let rows; 
	for(let i=0;i<positions.lenght;i++){
		for(let j=0; j<Object.keys(positions[i]).lengthk ;j++){
			let queryText = 'INSERT INTO positions '
			let queryName = '(';
			let queryValue = '(';
			for(let key in positions[i]){
				queryName += key+',';
				queryValue += positions[i].key+',';
			}
			queryName = queryName.slice(0,1)+')';
			queryValue = queryValue.slice(0,1)+')' ;
			queryText+= queryName + queryValue + ';';
		}
		try{
			conn = await pool.getConnection();
			rows = await conn.query(queryText);
		}catch(err){
			wsLog(err);
		}finally{
			if(conn){
				conn.end();
			}
		}
	}
}
//[task]class化
//まとめる
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
			wsLog('エラー');
			wsLog(error);
		}
		const message = JSON.parse(body);
		if(message.error){
			wsLog("send error");
			wsLog(data.clOrdID);
			wsLog(message);
			mexError[data.symbol+data.ordType]= true;
			switch(data.clOrdID){
				case"LNGLimit"+LNGLimitOrder.nonce:
					if(LNGStopOrder.target === true){
						LNGLimitOrder.target = true;
						orderFinishProc();
						return;
					}
					break;
				case"LNGStop"+LNGStopOrder.nonce:
					if(LNGLimitOrder.target === true){
						LNGStopOrder.target = true;
						orderFinishProc();
						return;
					}
					break;
				case"MIDLimit"+MIDLimitOrder.nonce:
					if(MIDStopOrder.target === true){
						MIDLimitOrder.target = true;
						orderFinishProc();
						return;
					}
					break;
				case"MIDStop"+MIDStopOrder.nonce:
					if(MIDLimitOrder.target === true){
						MIDStopOrder.target = true;
						orderFinishProc();
						return;
					}
					break;
			}
			setTimeout(reOrder,2000,data);
		}
		return;
	});
}
function cancelOrder(clOrdID){
	const verb = 'DELETE';
	const path = '/api/v1/order';
	const expires = Math.round(new Date().getTime() / 1000) + 60; // 1 min in the future
	const postBody = JSON.stringify({clOrdID:clOrdID});
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
			wsLog(error);
		}
		const message = JSON.parse(body);
		if(message.error){
			wsLog("cancel error");
			wsLog(clOrdID);
			wsLog(message);
			//もしcancel
		}
		return message;
	});
}
//orderデータの関数化
function limitData(symbol,side,orderQty,price,nonce){
	var data = {
		symbol:"XBT"+symbol,
		side:side,
		orderQty:orderQty,
		price:price,
		ordType:"Limit",
		clOrdID:clID[symbol]+"Limit"+nonce,
		execInst:"ParticipateDoNotInitiate"
	};
	return data;
}
function stopData(symbol,side,orderQty,price,nonce){
	var data = {
		symbol:"XBT"+symbol,
		side:side,
		orderQty:orderQty,
		stopPx:price,
		ordType:"Stop",
		clOrdID:clID[symbol]+"Stop"+nonce,
		execInst:"LastPrice"
	};
	return data;
}
function marketData(symbol,side,orderQty,nonce){
	var data = {
		symbol:"XBT"+symbol,
		side:side,
		orderQty:orderQty,
		ordType:"Market",
		clOrdID:nonce
	};
	return data;
}
function reOrder(data){
	//[task]targetがcancelになってるかどうかの確認
	wsLog("reorder");
	wsLog(data);
	if(data.symbol == XBTLNG){
		if(data.side == 'Buy'){
			switch (data.ordType){
				case 'Limit':
					if(LNGLimitOrder.target != "open"){
						wsLog("LNG Limit return");
						if(LNGStopOrder.target === true){
							LNGLimitOrder.target = true;
							orderFinishProc();
						}
						return;
					}
					data.price = price.LNGbid;
					positions[ordNo].LNGopenPrice = price.LNGbid;
					break;
				case 'Stop':
					if(LNGStopOrder.target != "open"){
						wsLog("LNG stop return");
						if(LNGLimitOrder.target === true){
							LNGStopOrder.target = true;
							orderFinishProc();
						}
						return;
					}
					data.stopPx= price.LNGask+0.5;
					break;
			}
		}else{
			switch (data.ordType){
				case 'Limit':
					if(LNGLimitOrder.target != "open"){
						wsLog("LNG Limit return2");
						if(LNGStopOrder.target === true){
							LNGLimitOrder.target = true;
							orderFinishProc();
						}
						return;
					}
					data.price = price.LNGask;
					positions[ordNo].LNGclosePrice = price.LNGask;
					break;
				case 'Stop':
					if(LNGStopOrder.target != "open"){
						wsLog("LNG stop return2");
						if(LNGLimitOrder.target === true){
							LNGStopOrder.target = true;
							orderFinishProc();
						}
						return;
					}
					data.stopPx= price.LNGbid-0.5;
					break;
			}
		}
	}else if(data.symbol == XBTMID){
		if(data.side == 'Buy'){
			switch (data.ordType){
				case 'Limit':
					if(MIDLimitOrder.target != "open"){
						if(MIDStopOrder.target === true){
							MIDLimitOrder.target = true;
							orderFinishProc();
						}
						return;
					}
					data.price = price.MIDbid;
					positions[ordNo].MIDclosePrice = price.MIDbid;
					break;
				case 'Stop':
					if(MIDStopOrder.target != "open"){
						if(MIDLimitOrder.target === true){
							MIDStopOrder.target = true;
							orderFinishProc();
						}
						return;
					}
					data.stopPx= price.MIDask+0.5;
					break;
			}
		}else{
			switch (data.ordType){
				case 'Limit':
					if(MIDLimitOrder.target != "open"){
						if(MIDStopOrder.target === true){
							MIDLimitOrder.target = true;
							orderFinishProc();
						}
						return;
					}
					data.price = price.MIDask;
					positions[ordNo].MIDopenPrice = price.MIDask;
					break;
				case 'Stop':
					if(MIDStopOrder.target != "open"){
						if(MIDLimitOrder.target === true){
							MIDStopOrder.target = true;
							orderFinishProc();
						}
						return;
					}
					data.stopPx= price.MIDbid-0.5;
					break;
			}
		}
	}
	wsLog("send reorder");
	sendOrder(data);
}
function tweetTrade(pos){
	let text;
	if(orderDirection == 'open'){
		text =
		   	'ポジションオープン'+'\n'+
			'open 価格: '+Math.floor(pos.openPrice)+'\n'+
			'close閾値: '+pos.closeLimit+'\n'+
			'ポジションサイズ: '+pos.LNGamount+'\n';
	}else{
		text = 
			'ポジションクローズ'+'\n'+
			'open 価格: '+Math.floor(pos.openPrice)+'\n'+
			'close価格: '+Math.floor(pos.closePrice)+'\n'+
			'ポジションサイズ: '+pos.LNGamount+'\n'+
			'利益: '+pos.profit+'\n'+
			'利益(usd): '+pos.profit*pos.LNGclosePrice;
	}
	twitter.tweet(text);	
}
var lastTweet = new Date();
function tweetStat(){
	const date = new Date();
	if(date - lastTweet < 1000*60*60){
		return;
	}
	lastTweet = date;
	let text= 'open: '+openDiff+' close: '+closeDiff;
	//ポジション一覧
	for(let i=0;i<positions.length;i++){
		if(positions[i].closeLimit){
			text +='\n'+'limit'+i+': '+positions[i].closeLimit;
		}
	}

	twitter.tweet(text);
}
//ログ出力
var socketCon = false;
io.on('connection',(socket)=>{
	socketCon = true;
	socket.on('disconnect',()=>{
		socketCon = false;
	});
});
function wsLog(logText){
	if(socketCon){
		io.emit('message',logText);
	}
}
app.get('/',(req,res)=>{
	res.sendFile(__dirname+'/index.html');
});
http.listen(PORT,()=>{
	console.log('server listening port:'+PORT);
});
