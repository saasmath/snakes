//var process = require('process');
var http = require('http');
var express = require('express');
var socketio = require('socket.io');
var readline = require('readline');
var colors = require('colors');
var util = require('util');
var browserify = require('browserify');
var fs = require('fs');
var cookie = require('cookie');
var facebook = require('./facebook');

require('./util');
require('./color');
require('./vector');
require('./entity');
require('./ball');
require('./world');
require('./snake');
require('./player');
require('./game');
require('./gamemanager');
//universe = new World(2000, 2000);


var app = express(/*{
    key: fs.readFileSync('ssl/privatekey.pem'),
    cert: fs.readFileSync('ssl/certificate.pem')
}*/);
var port = +process.argv[2] || 8090;
var server = app.listen(port);

var io = socketio.listen(server);
io.configure('development', function() {
	io.set('log level', 1);
	io.set('close timeout', 2.5);
});

var gameManager = new GameManager(io);
io.sockets.on('connection', gameManager.playerListener());

app.configure(function() {
	app.use(express.static(__dirname + '/public', {maxAge: 60000}));
	app.use(express.bodyParser());
	app.use(express.cookieParser());
	app.use(facebook.middleware);
	app.use(express.errorHandler({ dump: true, stack: true }));
	console.log(process.env.FACEBOOK_APP_ID, process.env.FACEBOOK_SECRET);
	app.set('view options', { layout: false });
	app.set('view engine', 'ejs');

	app.use(function addLocals(req, res, next) {
		res.locals.host = req.headers['host'];
		res.locals.scheme = req.headers['x-forwarded-proto'] || 'http';
		res.locals.url = function(path) {
			return res.locals.scheme + res.locals.url_no_scheme(path);
		};
		res.locals.url_no_scheme = function(path) {
			return '://' + res.locals.host + (path || '');
		};
		res.locals.app = {id: process.env.FACEBOOK_APP_ID};
		next();
	});
});
app.get('/script.js', function(req, res) {
	browserify([
		'events',
		'util',
		'./color',
		'./client',
		'./explosion',
		'./snake',
		'./vector',
		'./ball',
		'./entity',
		'./world'
	]).bundle(function(err, src) {
		console.log(err);
		res.contentType('js');
		res.end(src);
	})
});
app.get('/games/:id/log', function (req, res) {
	fs.readFile('logs/'+ req.params.id, 'utf8', function (err, data) {
		if(!err)
			res.send(data.replace(/\u001B\[[^m]+m/g, '').split('\n').join('\<br />'));
		else {
			res.status(404);
			res.send('log not found')
		}
	});
});
app.get('/games/:id', function (req, res) {
	res.cookie('room', req.params.id, { maxAge: 900000 });
	res.render(__dirname + '/index', {port: port, room: req.params.id, gameName: 'Snake or Break'});
});
app.get('/games', function (req, res) {
	res.render(__dirname + '/games', {games: gameManager.games, gameName: 'Snake or Break'});
});
app.get('/', function (req, res) {
	res.render(__dirname + '/index', {port: port, room: gameManager.defaultGame.name, gameName: 'Snake or Break'});
});
app.get('/local', function (req, res) {
	res.sendfile(__dirname + '/snakes.html');
});
app.get('/log', function (req, res) {
	fs.readFile('game.log', 'utf8', function (err, data) {
		res.send(
			data
				.replace(/\u001B\[[^m]+m/g, '')
				.split('\n').join('\<br />')
		);
	});
});

app.get('/fblogin', function(req, res) {
	console.log(req.headers['host']);
	req.facebook.app(function(err, app) {
		console.log(app);
		req.facebook.me(function(err, user) {
			res.render(__dirname + '/fb', {
				req:       req,
				app:       app,
				user:      user
			});
		});
	});
});
app.get('/whoami', function(req, res) {
	req.facebook.me(function(err, user) {
		res.send("Got back sdfkjs;dfkjs;dlfkjs;ldfkjs;ldkfjs;ldkfjs;ldkfjs;ldjfs;lkfj;sdlkfjs;lkdjf;slkdf;skfd: " + user);
	});
	console.log(req.headers);
});
function htmlEntities(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


setInterval(function() {
	gameManager.games.forEach(function(game) {
		io.sockets.in(game.name).emit('scores', game.scores());
	});
}, 500);

(function makeCLI() {
	var logfile = fs.createWriteStream('game.log', {flags: 'a+'});

	//Create a command line interface from the console
	var cli = readline.createInterface(
		process.stdin,
		process.stdout,
		function (line) {
			var playercommands = ['kick', 'kill', 'spawn', 'help'];
			var commands = ['mass', 'balls'];
			var allCommands = playercommands.concat(commands)

			for(var i = 0; i < playercommands.length; i++) {
				var command = playercommands[i]
				if(line.indexOf(command) == 0) {
					var name = line.substr(command.length + 1);
					var completions = [];
					Object.forEach(gameManager.defaultGame.players, function(p, n) {
						if(n.indexOf(name) == 0)
							completions.push(command + ' ' + n);
					})
					return [completions, line];
				}
			}

			var hits = allCommands.filter(function(c) {
				return c.indexOf(line) == 0;
			});
			return [hits && hits.length ? hits : completions, line];
		}
	);
	cli.setPrompt("> ".grey, 2);

	//Fix the way the cli handles logging while the user is typing
	(function() {
		var oldWrite = process.stdout.write;
		var newStdout = Object.create(process.stdout);
		newStdout.write = function() {
			cli.output.write('\x1b[2K\r');
			var result = oldWrite.apply(this, arguments);
			logfile.write.apply(logfile, arguments);
			cli._refreshLine();
			return result;
		}
		process.__defineGetter__('stdout', function() { return newStdout; });
	})();

	function Command(pattern, f) {
		this.pattern = pattern;
		this.f = f;
	}
	Command.prototype.tryRun = function(line) {
		var matches = this.pattern.exec(line);
		if(matches) this.f.apply(this, matches);
		return matches != null;
	};

	var commands = [
		new Command(/^\s*players/, function() {
			util.log(Object.values(gameManager.defaultGame.players).pluck('coloredName').join(', '));
		}),
		new Command(/^\s*game/, function() {
			console.log(gameManager.defaultGame);
		}),
		new Command(/^\s*mass/, function() {
			console.log('Total mass of the universe: '+gameManager.defaultGame.world.totalMass);
		}),
		new Command(/^\s*score/, function() {
			var width = cli.columns;
			var perMass = width / gameManager.defaultGame.world.totalMass;
			var bar = "";
			var barLength = 0;
			var scoreSoFar = 0;

			Object.forEach(gameManager.defaultGame.players, function(p) {
				if(p.snake) {
					var score = p.snake.mass;
					scoreSoFar += score;
					var thisBar = "";
					while(barLength + thisBar.length < scoreSoFar * perMass)
						thisBar += '█';

					barLength += thisBar.length;
					bar += thisBar.colored(p.color);
				}
			});

			console.log(bar);
			console.log(Object.values(gameManager.defaultGame.players).pluck('coloredName').join(', '));
		}),
		new Command(/^\s*balls (\d+)/, function(n) {
			gameManager.defaultGame.generateBalls(+n);
		}),
		new Command(/^\s*kick (.+)/, function(name) {
			var player = gameManager.defaultGame.players[name]
			player && player.disconnect();
		}),
		new Command(/^\s*kill (.+)/, function(name) {
			var player = gameManager.defaultGame.players[name]
			player && player.kill();
		}),
		new Command(/^\s*spawn (.+)/, function(name) {
			var player = gameManager.defaultGame.players[name]
			player && !player.snake && player.spawnSnake(gameManager.defaultGame.world);
		}),
		new Command(/^\s*help (.+)/, function(name) {
			var player = gameManager.defaultGame.players[name]
			player && player.snake && (player.snake.maxMass *= 2);
		}),
		new Command(/^(.+)/, function(msg) {
			util.log('sending "'.grey+msg+'"'.grey);
			io.sockets.emit('servermessage', ""+msg);
		})
	]

	//Add commands
	cli.on('line', function(line) {
		var success = commands.some(function(c) {
			return c.tryRun(line);
		});
		cli.prompt();
	}).on('close', function() {
		io.sockets.emit('servermessage', 'Server going down!');
		io.sockets.emit('serverstop');
		process.exit(0);
	});
	cli.prompt();
})();