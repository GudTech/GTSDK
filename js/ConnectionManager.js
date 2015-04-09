// This class:
// contains the logic (might become rather complex) for selecting active
// connections, killing unused connections, and connecting

Ext.define('GT.api.ConnectionManager', {
    requires: [ 'GT.api.Connection' ],

    // tuning constants
    evalInterval: 250,
    pingInterval: 5000,
    switchAt1: 1000,
    switchAt2: 200,
    switchAt5: 50,
    satisfactory: 500,
    cullTimeout: 20000,

    constructor: function (config) {
        // a node descriptor is a (mutable, uniquely instantiated per connection manager) hash of:
        //   authority: host:port string
        //   penalty: rtt penalty as appropriate for the zone
        this._known = {};       // index
        this._prio  = [];
        this._prios = { cached: [], tailored: [], fallback: [] };
        this._userPref = null;
        this._triedThisCycle = {};

        // in general _known will only grow as we pick new prio lists.  though, we make an effort to get
        // off of nonprioritized nodes!

        this.target = config.target;

        this._backoffTimer = 1;
        this._backoffDepth = 0;
    },

    evaluate: function () {
        var target = this._getConnTarget();

        this._killStale(target);

        if (! --this._backoffTimer) {
            if (this._connect(target)) {
                this._backoffDepth++;
                // 0.25s, +50% for each attempt after the 3rd, max 4s
                this._backoffTimer = Math.min(16, Math.max(1, Math.floor(Math.pow(1.5, this._backoffDepth - 3))));
                //console.log('backoff', this._backoffTimer * 0.25, 'at', new Date());
            } else {
                this._backoffDepth = 0;
                this._backoffTimer = 1;
                this._triedThisCycle = {};
            }
        }

        this._pickBest();
    },

    _getConnTarget: function () {
        // might make this variable in the future if need presents
        // try to maintain 3 connections of ping < 500ms
        return 3;
    },

    _pickBest: function () {
        var options = [],
            me = this,
            abs = Math.abs,
            oldbest = me.target.active,
            priorities = me._prio,
            newbest;

        Ext.Object.each( me.target.connections, function (id, conn) {
            var auth = conn.authority;
            if (conn.state != 'open') return;
            options.push([ priorities[auth], conn.recentPings(), conn == oldbest, conn, auth == me._userPref ? 1 : 0 ]);
        });
        if (!options.length) return; // none good
        options.sort(function (a,b) { // returns "a-b" ish
            var tmp,
                aprio = a[0], bprio = b[0], // penalty, lower=better, unless undefined
                aping = a[1], bping = b[1];

            tmp = (aprio ? 1 : 0) - (bprio ? 1 : 0);
            if (tmp) return tmp; // use nodes from the current list if possible

            tmp = bprio*bping.last - aprio*aping.last; // swapped because lower is better
            if (abs(tmp) > me.switchAt1) return tmp; // this connection is in a bad way

            tmp = a[4] - b[4];
            if (tmp) return tmp;

            tmp = bprio*bping.min2 - aprio*aping.min2; // swapped because lower is better
            if (abs(tmp) > me.switchAt2) return tmp; // this connection is having some trouble

            tmp = bprio*bping.min5 - aprio*aping.min5; // swapped because lower is better
            if (abs(tmp) > me.switchAt5) return tmp; // this connection seems better

            tmp = (a[2] ? 1 : 0) - (b[2] ? 1 : 0);
            if (tmp) return tmp; // neither is compellingly better, stick with what we have

            return 0; // doesn't matter, don't care if it's stable
        });
        //console.log("_pickBest", [].concat(options));

        me.target.setActive( options.pop()[3] );
    },

    // kill connections that are over the target and haven't been used in a while
    _killStale: function (targno) {
        var me = this,
            droppable = [],
            keptAuths = {},
            totalKept = 0;

        Ext.Object.each( me.target.connections, function (id, conn) {
            if (conn.state != 'open') return;
            var auth = conn.authority,
                desc = me._known[auth],
                prio = me._prio[auth];
            droppable.push([ desc, conn, prio * conn.recentPings().min5 ]);
        });

        droppable.sort(function(a,b) { return a[2] - b[2]; });
        // from now on, better = first

        Ext.Array.forEach(droppable, function (a) {
            var desc = a[0], conn = a[1],
                auth = conn.authority;

            if (totalKept < targno && !keptAuths[auth]) {
                // keep the targno best, but never more than one per authority
                keptAuths[auth]=1;
                totalKept++;
                return;
            }

            if (conn == me.target.active) return;
            // keep usable connections around for a bit
            // exception: redundant connections to the same host are rarely useful
            if (me._prio[auth] && !keptAuths[auth] && conn.activity >= Date.now() - me.cullTimeout) return;

            console.log('shutdown', auth);
            conn.shutdown();
        });
    },

    // if we're low on connections, try to connect to more
    // a node is connectable if it doesn't have a good connection and hasn't seen a connection attempt in 10min
    // connect to the first such node if it's before the last connected node (return to preferred nodes)
    // connect to the first such node if it's after the last connected node and connections < target
    // rate limiting is handled in _evaluate; return true if you did anything
    // successfully connecting a node erases connection failure status.  if there are no connectable nodes
    // and less than the target, erase connection failures and try again.  if we go from >0 to 0 to >0
    // connections, we probably just had a general network hiccup and should also erase failures

    _connect: function (targno) {
        var me = this,
            known = me._known,
            prio = me._prio,
            so_far = 0, i,
            connect_to,
            best_ignoring_failures, // what connect_to would be if we cleared the failure info
            goodConns = {},
            pendingConns = {},
            bestPing = {},
            attempts = me._triedThisCycle,
            new_conn,
            auth, ex_conns, active, pending;

        Ext.Object.each(me.target.connections, function (id, conn) {
            auth = conn.authority;
            bestPing[auth] = Math.min( conn.recentPings().last, bestPing[auth] || Infinity );
            if (conn.state == 'open') {
                if (conn.recentPings().last < me.satisfactory) goodConns[auth] = 1;
            } else if (conn.state == 'connecting') {
                pendingConns[auth] = (pendingConns[auth] + 1) || 1;
            }
        });

        for (i = 0; i < prio.length && so_far < targno; i++) {
            auth = prio[i].authority;

            if (goodConns[auth]) {
                // let's run with it
                so_far++;
                continue;
            }

            if (pendingConns[auth] && bestPing[auth] < 500 * Math.pow(2, pendingConns[auth]))
                continue; // throttle reattempts for the same host

            if (!attempts[auth]) {
                // not connecting and not recently tried, let's go for it
                connect_to = prio[i];
                best_ignoring_failures = best_ignoring_failures || connect_to;
                break;
            } else {
                best_ignoring_failures = best_ignoring_failures || prio[i];
            }
        }

        if (!connect_to && so_far < targno && best_ignoring_failures) {
            // we need more nodes, but we've exhausted the list, but the exhaustion is due to remembering failures
            // clear the failures and cycle through again
            me._triedThisCycle = {};
            connect_to = best_ignoring_failures;
        }

        // do we want to connect to anything?
        if (!connect_to) return false; // no action, for the backoff

        me._triedThisCycle[connect_to.authority] = 1;
        me.target.addConnection( new GT.api.Connection({ authority: connect_to.authority, pingPeriod: me.pingInterval }),
                function (conn) {
                    if (conn.recentPings().last < me.satisfactory / 2) delete me._triedThisCycle[conn.authority];
                    // a successful connection obsoletes all pending connections to the same host
                    setTimeout( function () { me._killAttempts( connect_to.authority ) }, 1 );
                });
        return true;
    },

    _killAttempts: function (auth) {
        Ext.Object.each(this.target.connections, function (id, conn) {
            if (conn.authority == auth && conn.state == 'connecting') conn.shutdown();
        });
    },

    // Makes some nodes known.  Each node must have 'authority' field.
    // authority is a pkey, everything else can be modified this way.
    assertNodes: function (nodes) {
        var me = this, known = me._known;
        Ext.Array.forEach(nodes, function (nd) {
            var auth = nd.authority;
            known[auth] = nd;
        });
        me.buildPriorities();
    },

    // After asserting nodes you can ask for them to be used. :D
    // Actually we have a couple of priority bits which are combined to make the final priority list:
    //    User configuration (not yet done)
    //    Cached node list
    //    Tailored node list
    //    Bootstrap/fallback node list
    setPriorityList: function (list, zone_auths) {
        if (!this._prios[list]) throw "invalid list name";
        this._prios[list] = zone_auths;
        this.buildPriorities();
    },

    setUserPref: function (pref) {
        this._userPref = pref;
        this.buildPriorities();
    },

    buildPriorities: function () {
        var me = this,
            prios = me._prios,
            use,
            pref = me._userPref,
            penalty = 1;

        // rebuild the used list
        use = prios.tailored.length ? [].concat(prios.tailored) :
            prios.cached.concat(prios.fallback);

        if (pref && me._known[pref]) {
            // user preference affects connection order, but the biggest effect is on selection above
            use.unshift([pref]);
        }

        var prilist = me._prio = [];
        Ext.Array.forEach( use, function (z) {
            Ext.Array.forEach(z, function (auth) {
                var p = me._known[auth];
                if (!prilist[auth]) {
                    prilist.push(p);
                    prilist[auth] = penalty;
                }
            });
            penalty *= 1.2;
        });
    },

    // functionally this is a left outer join
    getConnectionInfo: function (all) {
        var me = this,
            target = me.target,
            active = target.active,
            known = me._known,
            keys = all ? Ext.Object.getKeys(known) : active ? [active.authority] : [],
            results = [],
            activeConns = {};

        Ext.Object.each(this.target.connections, function (id, conn) {
            var auth = conn.authority;
            (activeConns[auth] || (activeConns[auth] = [])).push(conn);
        });

        Ext.Array.forEach(keys, function (key) {
            var infoblock = known[key],
                connections = activeConns[key] || [ ];

            if (!connections.length) connections.push(null);
            if (!all) connections = active ? [active] : [];

            Ext.Array.forEach(connections, function(conn) {
                results.push({
                    status: !conn ? 'standby' :
                        conn.state == 'open' ? (conn == active ? 'active' : 'spare') :
                        conn.state,
                    user_select: key == me._userPref,
                    zone: infoblock.zonename,
                    name: infoblock.shortname,
                    ping: conn && conn.recentPings().last,
                    authority: key,
                });
            });
        });
        return results.sort(function (a,b) { var x=a.zone + a.name, y = b.zone + b.name; return x<y ? -1 : x==y ? 0 : 1; });
    },
});
