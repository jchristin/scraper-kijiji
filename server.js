"use strict";

var _ = require("lodash"),
	async = require("async"),
	cron = require("cron"),
	request = require("request"),
	superagent = require("superagent"),
	cheerio = require("cheerio"),
	mongoClient = require("mongodb").MongoClient,
	database;

function removeApartment(apartment) {
	superagent
		.delete(process.env.FLEUB_URL + "/api/apart")
		.send(apartment)
		.end(function(err) {
			if (err) {
				console.log(err);
			} else {
				console.log("Dead apartment: " + apartment.url);
			}
		});
}

function timestampApartment(apartment) {
	database.collection("apartments").updateOne({
		_id: apartment._id
	}, {
		$set: {
			last: apartment.last
		}
	}, function(err) {
		if (err) {
			console.log(err);
		}
	});
}

// Returns true is they are equal.
function compareApartment(apartment, newApartment) {
	if(!_.isEqual(apartment.images, newApartment.images)) {
		console.log("Images are different");
		console.log("Old: " + apartment.images);
		console.log("New: " + newApartment.images);
		return false;
	}

	if(apartment.address != newApartment.address) {
		console.log("Address is different");
		console.log("Old: " + apartment.address);
		console.log("New: " + newApartment.address);
		return false;
	}

	if(apartment.price != newApartment.price) {
		console.log("Price is different");
		console.log("Old: " + apartment.price);
		console.log("New: " + newApartment.price);
		return false;
	}

	if(apartment.description != newApartment.description) {
		console.log("Description is different");
		console.log("Old: " + apartment.description);
		console.log("New: " + newApartment.description);
		return false;
	}

	if(apartment.bedroom != newApartment.bedroom) {
		console.log("Bedroom is different");
		console.log("Old: " + apartment.bedroom);
		console.log("New: " + newApartment.bedroom);
		return false;
	}

	return true;
}

function scrapApartment(apartment, update) {
	console.log("Scrap: " + apartment.url);

	request({
		url: apartment.url + "?siteLocale=en_CA"
	}, function(error, response, body) {
		if (error) {
			console.log(error);
			return;
		}

		if (response.statusCode != 200) {
			console.log(apartment.url + ": " + response.statusCode);
			console.log(body);
		}

		if(/http:\/\/www\.kijiji\.ca\/b-/.test(response.request.uri.href)) {
			removeApartment(apartment);
			return;
		}

		if(response.request.uri.href.indexOf("set-location") > -1) {
			removeApartment(apartment);
			return;
		}

		var $ = cheerio.load(body);
		if ($("div.expired-ad-container").length > 0 || $("div.message-container").length > 0) {
			removeApartment(apartment);
			return;
		}

		var houseRental = /http:\/\/www\.kijiji\.ca\/v-house-rental/.exec(response.request.uri.href);
		if(houseRental !== null) {
			removeApartment(apartment);
			return;
		}

		var newApartment = {};

		newApartment.images = $("div[id=ImageThumbnails] img").map(function() {
			return $(this).attr("src").replace("$_14", "$_27");
		}).get();

	 	newApartment.address = $("table.ad-attributes tr").next().next().find("td")["0"].children[0].data;

		var priceString = $("span[itemprop=price] strong").html().replace(/[\$,]/g, "");
		newApartment.price = parseInt(priceString) || null;
		newApartment.active = true;
		newApartment.description = $("span[itemprop=description]").html();

		var roomRegExpResult = /http:\/\/www\.kijiji\.ca\/v-bachelor-studio/.exec(response.request.uri.href);
		if(roomRegExpResult !== null) {
			newApartment.bedroom = 0;
		} else {
			roomRegExpResult = /http:\/\/www\.kijiji\.ca\/v-(\d)-/.exec(response.request.uri.href);
			if(roomRegExpResult !== null) {
				newApartment.bedroom = parseInt(roomRegExpResult[1]);
			} else {
				roomRegExpResult = /http:\/\/www\.kijiji\.ca\/.+-(\d)-1-2/.exec(response.request.uri.href);
				if(roomRegExpResult !== null) {
					switch(parseInt(roomRegExpResult[1])) {
						case 1:
							newApartment.bedroom = 0;
							break;
						case 2:
							newApartment.bedroom = 1;
							break;
						case 3:
							newApartment.bedroom = 1;
							break;
						case 4:
							newApartment.bedroom = 2;
							break;
						case 5:
							newApartment.bedroom = 3;
							break;
						default:
							newApartment.bedroom = 4;
					}
				}
			}
		}

		apartment.last = new Date();

		if(update && compareApartment(apartment, newApartment)) {
			console.log("No change: " + apartment.url);
			timestampApartment(apartment);
			return;
		}

		Object.assign(apartment, newApartment);

		superagent
			.post(process.env.FLEUB_URL + "/api/apart")
			.send(apartment)
			.end(function(err) {
				if (err) {
					if(err.status === 400)
					{
						console.log("Bad request: " + apartment.url);
						removeApartment(apartment);
					} else {
						console.log(err);
					}
				} else {
					if (update) {
						console.log("Update apartment: " + apartment.url);
					} else {
						console.log("New apartment: " + apartment.url);
					}
				}
			});
	});
}

function checkForNewApartment() {
	request("http://www.kijiji.ca/b-appartement-condo/ville-de-montreal/c37l1700281?ad=offering", function(error, response, body) {
		if (error) {
			console.log(error);
		} else if (response.statusCode == 200) {
			var $ = cheerio.load(body);

			$("div[data-vip-url]").each(function(index, element) {
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
			console.log(response.statusCode);
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
