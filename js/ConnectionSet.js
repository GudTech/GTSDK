// This class wraps a set of Connection objects and sends requests to the active one, queueing if none

Ext.define('GT.api.ConnectionSet', {

    constructor: function (config) {
        this.connections = {};  // will exclude closed items
        this.active = null;     // which to use - do not set directly
        // invariant: _active, if not null, points into _connected

        this._onconnect = [];
    },

    setActive: function (conn) {
        if (conn.state != 'open') throw "trying to activate a nonopen connection";
        if (this.connections[ conn.id ] != conn) throw "trying to activate an unregistered connection";
        if (conn == this.active) return;
        console.log('activating',conn.id,conn.authority);

        if (this.active) this.active.setActive(false);
        conn.setActive(true);
        this.active = conn;

        Ext.Array.forEach(Ext.Array.splice(this._onconnect,0), function(f) { f(); });
    },

    addConnection: function (conn, onOpen) {
        var me = this,
            connmap = me.connections,
            id = conn.id;

        if (connmap[ id ]) throw "connection is already registered";
        connmap[ id ] = conn;

        conn.on('statechange', function () {
            if (connmap[id] != conn) return; // paranoia
            if (conn.state != 'open' && conn == me.active) me.active = null;
            if (conn.state == 'closed') delete connmap[id];
            if (conn.state == 'open') onOpen(conn);
        });
    },

    dispatch: function (request, timeout, cb) {
        var me=this;
        if (!me.active) {
            me._onconnect.push( function () { me.dispatch(request, timeout, cb); } );
            return;
        }
        // TODO: perhaps timeout should start immediately/be handled outside here?
        // TODO: retry requests on another connection/zone if they fail before soa dispatch
        var active = this.active;
        this.active.request(request, timeout, function (err, rpy) { return cb(err, rpy, active); });
    },

    // used for second-chance dispatching
    randomStandbyConnection: function () {
        var sb = [], active = this.active;
        Ext.Object.each(this.connections, function (k, conn) { if (conn.state == 'open' && conn != active) sb.push(conn); });
        return sb.length ? sb[ Math.floor(Math.random() * sb.length) ] : null;
    },

    fetchDirectAPI: function (cb) {
        var me = this;
        if (!me.active) {
            me._onconnect.push( function () { me.fetchDirectAPI(cb); } );
            return;
        }
        this.active.fetchDirectAPI(cb);
    },
});
