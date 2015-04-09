// Represents a single websocket connection to a n
Ext.define('GT.api.Connection', {
    mixins: { observable: 'Ext.util.Observable' },
    statics: { _nextId: 1 },

    constructor: function (config) {
        this.mixins.observable.constructor.apply(this, arguments);

        this.id = this.statics()._nextId++;
        this.state = 'connecting';
        this.activity = Date.now();

        this._pending = [];
        this._pingResults = [];
        this._nextId = 1;

        this.authority = config.authority;
        this.pingPeriod = config.pingPeriod;

        this.connect();
    },

    _setState: function (state) {
        if (state == this.state) return;
        this.state = state;
        this.fireEvent('statechange');
    },

    connect: function() {
        var me  = this,
            url = "wss://" + this.authority + "/binaryjs2";

        me._socket = new BinaryClient(url);
        console.log('API Socket - connect', url);

        me._socket.on('stream', function (s, meta) {
            if (meta['class'] == 'ready') {
            } else if (meta['class'] == 'shutdown') {
                var cutoff = +meta['last_id'], handled = [], ignored = [];
                Ext.Array.forEach(me._pending, function (p) {
                    (p.id <= cutoff ? handled : ignored).push(p);
                });
                me._setState('closing');
                me._pending = handled;
                Ext.Array.forEach(ignored, function (p) { p.shutdown(); });
                me._checkClose();
            } else {
                console.error('unexpected server push:',meta);
            }
        });

        // treat the initial connection attempt as a ping send
        me._markPingSent();
        me._socket.once('open', function () {
            console.log('API Socket - open',url);
            me._markPingRecv();
            me._ping();
        });
        me._socket.on('close', function () {
            console.log('API Socket - close',url);
            me._setState('closed');
            me._socket = null;

            var pending = me._pending;
            me._pending = [];
            Ext.Array.forEach(pending, function (p) { p.drop(); });
        });
    },

    _ping: function () {
        var me = this;
        if (this.state != 'open' && this.state != 'connecting') return;

        me._markPingSent();

        if (me._simFrozen) return;
        var stream = me._socket.createStream({'class':'ping','cookie':''});
        var replied = false;
        stream.on('data', function() {
            if (replied) return;
            replied = true;
            me._markPingRecv();

            if (me.state == 'connecting') // we're officially open after the first ping reply
                me._setState('open');

            setTimeout( function() { me._ping(); }, me.pingPeriod );
        });
    },

    _markPingSent: function () {
        this._pingSent = Date.now();
    },

    _markPingRecv: function () {
        var me = this, res = me._pingResults;
        res.unshift( Date.now() - me._pingSent );
        me._pingSent = 0;
        if (res.length >= 10) res.pop();
    },

    recentPings: function() {
        var min = Infinity, mins = [], i, results = this._pingResults, dur, sent = this._pingSent;

        if (!results.length) results = [0];

        Ext.Array.forEach(results, function (dur) {
            if (dur < min) min = dur;
            mins.push(min);
        });

        // a pending ping ONLY counts towards ratings which it is longer than, with a weakening because we want min[4] to capture long-term behavior
        if (sent && (dur = Date.now() - sent)) {
            for (i = 0; i < mins.length; i++)
                mins[i] = Math.max(mins[i], dur - 50 * i);
        }

        return { last: mins[0], min2: mins[1] || mins[mins.length - 1], min5: mins[4] || mins[mins.length - 1] };
    },

    _checkClose: function () {
        if (this.state == 'closing' && !this._pending.length) {
            this._setState('closed');
            this._socket.close(4901, 'shutting down');
        }
    },

    _wrapCallback: function (cb, scope, timeout, id, dropargs, tmoutargs, shutdownargs) {
        var called = false,
            me = this,
            pendarr = this._pending,
            callcb = function () {
                if (called) return;
                called = true;
                Ext.Array.remove(me._pending, pendob); // array may be rebuilt
                clearTimeout(timer);
                cb.apply(scope, arguments);
                cb = null;
                me._checkClose();
            },
            pendob = {
                id: id,
                drop: function () { return callcb.apply(this, dropargs); },
                shutdown: function () { return callcb.apply(this, shutdownargs); },
            },
            timer  = setTimeout( function() { callcb.apply(this, tmoutargs); }, timeout );

        pendarr.push(pendob);
        return callcb;
    },

    fetchDirectAPI: function (cb) {
        cb = this._wrapCallback( cb, this, 30*1000, 0, [null], [null], [null] );
        this._socket.createStream({'class':'api'}).on('data', cb);
    },

    request: function (request, timeoutms, cb) {

        if (this.state != 'open') {
            throw "request dispatched to closed connection";
        }

        //console.log( 'dispatched to', this.authority );

        var id = this._nextId++;
        var stm = this._socket.createStream(Ext.apply({'class': 'request1', id: id}, request));

        var header;
        var bits = [];
        var cbcalled;
        var me = this;

        cb = this._wrapCallback( cb, this, timeoutms || 120*1000, id,
                [{code:'transport',message:'Connection lost'}, null],
                [{code:'transport',message:'Request timed out'}, null],
                [{code:'dispatcher_shutdown',message:''}, null] );

        var onerror = function(code, msg, data) { cb( { message: msg, code: code, data: data }, null ); };

        stm.on('data', function (d) { bits.push(d); });
        stm.on('end', function () {

            if (me._simFrozen) return;
            var header = bits.shift();

            if (header.error_code)
                return onerror(header.error_code, header.error, header.error_data);

            var txerr = bits.pop().txerr;
            if (txerr) return onerror('transport', txerr);

            // XXX BlobBuilder
            var blob = new Blob(bits);
            var reader = new FileReader();
            reader.onloadend = function () {
                if (reader.error)
                    return onerror('transport', 'UTF8 decode failed '+reader.error);

                var obj;
                try {
                    obj = Ext.decode(reader.result);
                } catch (e) {};

                if (obj) {
                    return cb(null, obj);
                } else {
                    return onerror('transport', 'JSON decode of payload failed');
                }
            };
            if (me.artificialLatency) {
                Ext.Function.defer( reader.readAsText, me.artificialLatency * (1 + Math.random()), reader, [blob] );
            } else {
                reader.readAsText(blob);
            }
        });
    },
    artificialLatency: 0,

    setActive: function(active) {
        if (this.state != 'open') return;
        if (active) this.activity = Date.now();

        this._socket.createStream({'class':'activity',active:active});
    },

    shutdown: function() {
        if (this.state != 'open' && this.state != 'connecting') throw "shutdown only legal when open";
        this._setState('closing');
        this._checkClose();
    },
});
