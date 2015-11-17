"use strict";

var async = require("async"),
	cron = require("cron"),
	request = require("request"),
	cheerio = require("cheerio"),
	moment = require("moment"),
	mongoClient = require("mongodb").MongoClient,
	database;

function removeApartment(apartment) {
	apartment.active = false;
	database.collection("apartments").update({
			_id: apartment._id
		}, apartment, {},
		function(err) {
			if (err) {
				console.log(err);
			} else {
				console.log("Dead apartment: " + apartment.url);
			}
		}
	);
}

function scrapApartment(apartment, update) {
	request({
		url: apartment.url + "?siteLocale=en_CA",
		followRedirect: false
	}, function(error, response, body) {
		if (error) {
			console.log(error);
		} else if (response.statusCode == 301) {
			removeApartment(apartment);
		} else if (response.statusCode == 200) {
			var $ = cheerio.load(body);

			if ($("div.expired-ad-container").length > 0 || $("div.message-container").length > 0) {
				removeApartment(apartment);
			} else {
				var priceString = $("span[itemprop=price] strong").html().replace(/[\$,]/g, "");
				var latitude = $("meta[property='og:latitude']").attr("content");
				var longitude = $("meta[property='og:longitude']").attr("content");

				apartment.coord = [parseFloat(longitude), parseFloat(latitude)];
				apartment.image = $("img[itemprop=image]").attr("src");
				apartment.price = parseInt(priceString);
				apartment.last = new Date();
				apartment.active = true;

				var roomRegExpResult = /http:\/\/www\.kijiji\.ca\/.+-(\d)-1-2\//.exec(apartment.url);
				apartment.room = roomRegExpResult ? parseInt(roomRegExpResult[1]) : undefined;

				var date = $("table.ad-attributes tr:first-child td").html();
				apartment.date = moment(date, "DD-MMM-YY").toDate();

				database.collection("apartments").update({
						_id: apartment._id
					}, apartment, {
						upsert: true
					},
					function(err) {
						if (err) {
							console.log(err);
						} else {
							if (update) {
								console.log("Update apartment: " + apartment.url);
							} else {
								console.log("New apartment: " + apartment.url);
							}
						}
					});
			}
		} else {
			console.log(apartment.url + ": " + response.statusCode);
			console.log(body);
		}
	});
}

function checkForNewApartment() {
	request("http://www.kijiji.ca/b-appartement-condo/ville-de-montreal/c37l1700281?ad=offering", function(error, response, body) {
		if (error) {
			console.log(error);
		} else if (response.statusCode == 200) {
			var $ = cheerio.load(body);

			$("table.regular-ad").each(function(index, element) {
				var url = "http://www.kijiji.ca" + $(element).attr("data-vip-url");

				database.collection("apartments").findOne({
					url: url
				}, {}, function(err, result) {
					if (err) {
						console.log(err);
					} else {
						if (!result) {
							var apartment = {
								url: url,
								source: "kijiji"
							};

							scrapApartment(apartment);
						}
					}
				});
			});
		} else {
			console.log("http://montreal.craigslist.ca/search/apa: " + response.statusCode);
			console.log(body);
		}
	});
}

function updateLastApartment() {
	database.collection("apartments").find({
		source: "kijiji",
		active: true
	}).sort({
		"last": 1
	}).limit(1).toArray(function(err, docs) {
		if (err) {
			console.log(err);
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
					console.log("IP: " + body.ip);
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
					console.log("Kijiji connectivity: " + response.statusCode);
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
			mongoClient.connect(process.env.MONGODB_URL, function(err, db) {
				if (err) {
					callback(err);
				} else {
					console.log("Connected to the database");
					database = db;
					callback();
				}
			});
		},
		// Start to scrap.
		function() {
			new cron.CronJob(process.env.CRON_EXP_CHECK, checkForNewApartment, null, true);
			new cron.CronJob(process.env.CRON_EXP_UPDATE, updateLastApartment, null, true);
		}
	],
	function(err) {
		console.log(err);
	});
