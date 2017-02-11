var express  = require('express');
app = express();
var port = process.env.PORT || 8080;
var bodyParser = require('body-parser');
var fs = require("fs");
var freegeoip = require('node-freegeoip');

var Redis = require('ioredis');
var redis = new Redis();

var Converter = require("csvtojson").Converter;
var converter = new Converter({});

app.use(bodyParser.json());     // support json encoded bodies
app.use(bodyParser.urlencoded({ extended: false }));    // support encoded bodies

var kafka = require('kafka-node'),
    Producer = kafka.Producer,
    client = new kafka.Client('34.154.148.149:2181'),
    producer = new Producer(client);

app.listen(port);
console.log('Server started! At http://localhost:' + port);

redis.on("connect", function(res){
    console.log("Redis started! Ready to perform");
});

var getClientAddress = function (req) {
    return (req.get('x-forwarded-for') || '').split(',')[0]  || req.connection.remoteAddress;
}

var getClientLocation = function (ipaddress, callback) {
    freegeoip.getLocation(ipaddress, function(err, location) {
        if (err) throw err;
        return callback(location);
    });
}

// If timestamp is not present, returns ISO format current timestamp.
var getTimeStamp = function(timestamp) {

    // If no timestamp given, should return current timestamp.
    if(timestamp) {

        // Only realtime events. Convert timestamp to ISOstring format.
        // Timestamps can be in milliseconds/microseconds.
        if(timestamp > 100000000000000){
            timestamp = Math.round(timestamp/1000);
        }
        else if(timestamp > 100000000000){
            timestamp = Math.floor(timestamp);
        }
        else{
            timestamp = timestamp * 1000;
        }
        return timestamp;
    }
    else {
        return new Date().toISOString().toString('utf8');
    }
}

var statsCollector = function(req, res) {
    // console.log(req.body);
    // console.log(req.get('content-type'));
    var date = new Date().toISOString().toString('utf8');
    try {
        var store = JSON.parse(JSON.stringify(req.body).toString('utf8').replace("'",'"'));
        store = JSON.parse(store.e); // Getting events list
    }
    catch (e) {
        console.log("Error in JSON Parsing!");
        return res.status(422).json({"status":false, "message":"Unparsble JSON"});
    }

    payloads = [];

    store.forEach(function(user_event) {

        var timestamp = getTimeStamp(user_event.timestamp)
        user_event.timestamp = new Date(timestamp).toISOString().toString('utf8');
        // Uncomment the following just in case to capture older events.
        // user_event.timestamp = new Date().toISOString().toString('utf8'); // Setting timestamp to current time.

        // Adding event_day IST and UTC format.
        console.log(user_event.timestamp);
        var currentUTCTime = new Date();
        var currentISTTime = new Date(currentUTCTime.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

        // Sometimes event_properties is missing. Addding empty one if not present.!
        if(!user_event.event_properties){
            user_event.event_properties = {};
            console.log("Event Properties Missing!");
        }

        // Tweaking for location data if lat is not present.
        if(!user_event.lat){
            clientIp = getClientAddress(req);
            getClientLocation("121.244.122.142", function(resp) {

                user_event.country = user_event.country || resp.country_name;
                user_event.region = user_event.region || resp.region_name;
                user_event.city = user_event.city || resp.city;
                user_event.lat = user_event.lat || resp.latitude;
                user_event.lng =  user_event.lng || resp.longitude;

            });

        }

        var medium = user_event.event_properties.utm_medium
        var source = user_event.event_properties.utm_source
        var campaign = user_event.event_properties.utm_campaign
        // Correcting UTM Sources from App Event
        if (!medium && !campaign && !source){
          medium = source = campaign = "Direct"
        }
        else{
          medium = medium || source || campaign || "Direct"
          source = source || medium || campaign
          campaign = campaign || medium || source
        }

        // Call get on redis only once and store it.
        var redis_result;
        // Should be this way. Seriously don't play with it.
        redis.get(user_event.device_id).then(function update_user_event(jredis_result) {

            redis_result = JSON.parse(jredis_result);

            if(user_event.event_type == "Session-Started") {

                // Redis data should be updated with current app session details.
                redis_result.medium = user_event.event_properties.utm_medium = medium;
                redis_result.source = user_event.event_properties.utm_source = source;
                redis_result.campaign = user_event.event_properties.utm_campaign = campaign;
                redis_result.user_id = user_event.user_id = user_event.user_id || redis_result.user_id;
                redis_result.email = user_event.email = user_event.email || redis_result.email;
                redis_result.advertiser_id = user_event.advertiser_id || redis_result.advertiser_id;

                // No need to write for every event Except this and the one below.
                redis.set(user_event.device_id, JSON.stringify(redis_result)); // Never expired details about user.

            }
            else {

                user_event.event_properties.utm_medium = redis_result.medium;
                user_event.event_properties.utm_source = redis_result.source;
                user_event.event_properties.utm_campaign = redis_result.campaign;
                user_event.user_id = user_event.user_id || redis_result.user_id;
                user_event.email = user_event.email || redis_result.email;

                if (user_event.event_type == "NEW_APP_INSTALLS"){
                    // Helps in deciding the uninstalls attributions %.
                    redis_result.user_installed_medium = redis_result.medium;
                    redis_result.user_installed_source = redis_result.source;
                    redis_result.user_installed_campaign = redis_result.campaign;

                    // No need to write for every event Except this and the one above.
                    redis.set(user_event.device_id, JSON.stringify(redis_result)); // Never expired details about user.

                }
            }
        
        });

        

        user_event.event_day = currentUTCTime.toLocaleString().split(',')[0];
        user_event.event_day_ist = currentISTTime.toLocaleString().split(',')[0];
        user_event.advertiser_id_met = user_event.advertiser_id;
        user_event.device_id_met = user_event.device_id;
        user_event.seller_met = user_event.event_properties.Seller;
        user_event.brand_met = user_event.event_properties['Brand Name'];
        user_event.product_size_met = user_event.event_properties.Size;

        var temp_obj = { topic: "vnk-clst", messages: JSON.stringify(user_event), partition: 0 };
        payloads.push(temp_obj);
    });

    // producer.send(payloads, function(err, data){
    //     // console.log(data);
    //     return res.status(200).json({ "status": false, "message": "OK" });
    // });

    producer.on('error', function(err){
        // console.log(err);
        // return res.status(500).json({ "status": false, "message": "Broker Not Available" });
    })

    res.end();

}


app.post('/user-activity-poc', statsCollector);
app.post('/stats', statsCollector);

app.post('/fireme',function(req, res) {

    // console.log(req.body);
    try {
        var store = JSON.parse(JSON.stringify(req.body).toString('utf8').replace("'",'"'));
    }
    catch (e) {
        console.log("Error in JSON Parsing!");
        return res.status(422).json({"status":false, "message":"Unparsble JSON"});
    }

    // Call get on redis only once and use it for attribution.
    var redis_result = "";
    getRedisResult(store[eve].device_id, function(jresult){
        result = JSON.parse(jresult);
        redis_result = result;
    });

    store.event_properties.utm_medium = redis_result.medium;
    store.event_properties.utm_source = redis_result.source;
    store.event_properties.utm_campaign = redis_result.campaign;
    store.advertiser_id = redis_result.advertiser_id;

    payloads = [];

    store.timestamp = getTimeStamp(); // Should be tagged with current timestamp.

    // Adding event_day IST and UTC format.
    var currentUTCTime = new Date();
    var currentISTTime = new Date(currentUTCTime.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    store.event_day = currentUTCTime.toLocaleString().split(',')[0];
    store.event_day_ist = currentISTTime.toLocaleString().split(',')[0];
    store.advertiser_id_met = store.advertiser_id;
    store.device_id_met = store.device_id;

    temp_obj = { topic: "vnk-clst", messages: JSON.stringify(store), partition: 0 };
    payloads.push(temp_obj);

    producer.send(payloads, function(err, data){
            console.log(data);
    });

    producer.on('error', function(err){
        console.log(err);
        return res.status(500).json({ "status": false, "message": "Broker Not Available" });
    })

    res.end();

});