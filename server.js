"use strict";

var async = require("async"),
	cron = require("cron"),
	request = require("request"),
	cheerio = require("cheerio"),
	logentries = require("node-logentries"),
	log = logentries.logger({
		token: process.env.LOGENTRIES_TOKEN
	}),
	mongoClient = require("mongodb").MongoClient,
	mongoUrl = "mongodb://flat-scraper-craigslist:" + process.env.MONGODB_PASSWORD + "@linus.mongohq.com:10059/flats",
	database;

if (process.env.NODE_ENV !== "production") {
	log.info = console.log;
	log.err = console.log;
}

function scrapApartment(apartment, update) {
	request(apartment._id, function(error, response, body) {
		if (error) {
			log.err(error);
		} else if (response.statusCode == 200) {
			var $ = cheerio.load(body);

			if ($("div.expired-ad-container").length > 0) {
				database.collection("active").remove({
					"_id": apartment._id
				}, function(err) {
					if (err) {
						log.err(err);
					} else {
						log.info("Dead apartment: " + apartment._id);
					}
				});
			} else {
				var priceString = $("span[itemprop=price] strong").html().replace(/&#xA0;/g, "");
				apartment.latitude = $("meta[property='og:latitude']").attr("content");
				apartment.longitude = $("meta[property='og:longitude']").attr("content");
				apartment.image = $("img[itemprop=image]").attr("src");
				apartment.price = parseInt(priceString);
				apartment.last = new Date();

				database.collection("active").update({
						_id: apartment._id
					}, apartment, {
						upsert: true
					},
					function(err) {
						if (err) {
							log.err(err);
						} else {
							if (update) {
								log.info("Update apartment: " + apartment._id);
							} else {
								log.info("New apartment: " + apartment._id);
							}
						}
					});
			}
		} else {
			log.err(apartment._id + ": " + response.statusCode);
			log.err(body);
		}
	});
}

function checkForNewApartment() {
	request("http://www.kijiji.ca/b-appartement-condo/ville-de-montreal/c37l1700281?ad=offering", function(error, response, body) {
		if (error) {
			log.err(error);
		} else if (response.statusCode == 200) {
			var $ = cheerio.load(body);

			$("table.regular-ad").each(function(index, element) {
				var url = "http://www.kijiji.ca" + $(element).attr("data-vip-url");

				database.collection("active").findOne({
					_id: url
				}, {}, function(err, result) {
					if (err) {
						log.err(err);
					} else {
						if (!result) {
							var apartment = {
								_id: url,
								source: "kijiji"
							};

							scrapApartment(apartment);
						}
					}
				});
			});
		} else {
			log.err("http://montreal.craigslist.ca/search/apa: " + response.statusCode);
			log.err(body);
		}
	});
}

function updateLastApartment() {
	database.collection("active").find({
		source: "kijiji"
	}).sort({
		"last": 1
	}).limit(1).toArray(function(err, docs) {
		if (err) {
			log.err(err);
		} else {
			var apartment = docs[0];
			if (apartment) {
				scrapApartment(apartment, true);
			}
		}
	});
}

// Execute each function in series.
async.series([
		// Display the server public IP address.
		function(callback) {
			request({
				url: "http://ipinfo.io",
				json: true
			}, function(error, response, body) {
				if (error) {
					callback(error);
				} else if (response.statusCode == 200) {
					log.info("IP: " + body.ip);
					callback();
				} else {
					callback(body);
				}
			});
		},
		// Check Kijiji connectivity.
		function(callback) {
			request("http://www.kijiji.ca/b-appartement-condo/ville-de-montreal/c37l1700281", function(error, response, body) {
				if (error) {
					callback(error);
				} else {
					log.info("Kijiji connectivity: " + response.statusCode);
					if (response.statusCode == 200) {
						callback();
					} else {
						callback(body);
					}
				}
			});
		},
		// Connect to the database.
		function(callback) {
			mongoClient.connect(mongoUrl, function(err, db) {
				if (err) {
					callback(err);
				} else {
					log.info("Connected to the database");
					database = db;
					callback();
				}
			});
		},
		// Start to scrap.
		function() {
			new cron.CronJob("*/30 * * * * *", checkForNewApartment, null, true);
			new cron.CronJob("*/5 * * * * *", updateLastApartment, null, true);
		}
	],
	function(err) {
		log.err(err);
	});
