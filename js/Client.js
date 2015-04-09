Ext.define('GT.api.Client', {
    singleton: true,
    mixins: { observable: 'Ext.util.Observable' },

    requires: [
        'GT.api.ZoneLoader',
        'GT.api.ConnectionManager',
        'GT.api.ConnectionSet',
        'GT.api.Connection',
    ],

    logoutTime: 1800*1000,
    renewTime:  40*1000,

    constructor: function () {
        var me = this;
        me.mixins.observable.constructor.apply(me, arguments);
        if (!window.gtZoneList) throw "Client must be configured with gtZoneList and gtAuthenticated prior to loading";

        me.zoneList = window.gtZoneList;
        me.authenticated = window.gtAuthenticated;

        me._conn_set = new GT.api.ConnectionSet({});
        me._manager  = new GT.api.ConnectionManager({ target: me._conn_set });

        me._apiNamespaces = [];
        me._apiCallbacks = [];

        me._conn_set.fetchDirectAPI(function (api) {
            me.generateFunctions( api );
        });

        // always try to get the fallback list
        GT.api.ZoneLoader.loadBootstrapZone( window.gtZoneList, me._manager, function (success) {
            if (!success) {
                // Not much we can do here
                Ext.Msg.show({ icon: Ext.Msg.ERROR, buttons: Ext.Msg.OK, title: '', msg: 'Failed to load bootstrap zone' });
            }
        });

        // get the tailored list from localStorage
        var cached = window.localStorage.getItem('gt.tailored-zone-cache');
        cached = cached && Ext.decode(cached, null);
        if (cached) {
            GT.api.ZoneLoader.parseZone( 'cached', true, cached, me._manager );
        }
        this._manager.setUserPref( window.localStorage.getItem('gt.user-node-override') );

        if (me.authenticated) {
            me.call('API.getNodeList~1', {}, function (res) {
                if (!res) return;
                if (GT.api.ZoneLoader.parseZone( 'tailored', true, res.nodelist, me._manager )) {
                    window.localStorage.setItem('gt.tailored-zone-cache', Ext.encode(res.nodelist));
                }
            });
        }

        me.resetLogoutTimer();
        me.renewSession();


        me._eval_timer = setInterval( function () {
            me._manager.evaluate();
            me.fireEvent('update');
        }, me._manager.evalInterval );
    },

    resetLogoutTimer: function() {
        clearTimeout(this._logoutTimer);
        if (!this.authenticated) return;
        var last = new Date();
        this._logoutTimer = setTimeout( function() {
            // alert('Logout timer hit after ' + (((new Date()) - last )/1000) + ' seconds'  );
            top.location = '/login';
        }, this.logoutTime );
    },


    renewSession: function () {
        var me = this;
        if (!this.authenticated) return;
        setTimeout( function() {
            me.request({
                action:  'User.updateSession',
                version: 1,
                params:  {},
                idle:    true,
                callback: function (d) {
                    if (d && d.session) {
                        window.sessionStorage.session = d.session;
                    }
                    me.renewSession();
                    return false; // ignore errors for this
                },
            });
        }, me.renewTime);
    },

    generateFunctions: function(defs) {
        if (this._apiNamespaces.length) return; // hack: don't follow lost APIs when the dispatcher restarts
        var me = this;
        Ext.Array.forEach(this._apiNamespaces, function (ns) { delete window[ns]; });

        Ext.Array.forEach(defs, function (desc) {
            var parts = desc[0].split('.');
            var end   = parts.pop();
            var ns    = parts.join('');
            if (desc[1] != 1) ns = ns + 'V' + desc[1];

            if (!window[ns]) {
                window[ns] = {};
                me._apiNamespaces.push(ns);
            }
            window[ns][end] = function(params, cb, scope) {
                return me.request({ action: desc[0], version: desc[1], params: params, callback: cb, scope: scope });
            };
        });

        Ext.Array.forEach(this._apiCallbacks, function(c) { c[0].call(c[1]); });
        this._apiCallbacks = [];
    },

    // for early startup purposes: delay something until the API is available
    onAPI: function(cb, scope) {
        if (this._apiNamespaces.length) {
            return cb.call(scope);
        } else {
            this._apiCallbacks.push([cb,scope]);
        }
    },

    call: function (actionstr, params, cb, scope) {
        var acsplit = actionstr.split('~');
        if (acsplit.length != 2) throw 'action string must be ACTION~VERSION';

        this.request({ action: acsplit[0], version: +acsplit[1], params: params, callback: cb, scope: scope });
    },

    _dispatch: function (req, timeout, specific, cb) {
        if (specific)
            return specific.request(req, timeout, function (err, rpy) { return cb(err, rpy, specific); });
        else
            return this._conn_set.dispatch(req, timeout, cb);
    },

    getTerminal: function () { return localStorage.terminal; },
    getSession: function () { return sessionStorage.session; },
    request: function (args) {
        var me = this;
        if (!args.idle) console.log( 'API Request -', args.action, 'v' + args.version, args.params );
        if (!args.idle) this.resetLogoutTimer();

        this._dispatch({
            action: args.action, params: args.params, version: args.version,
            envelope: args.store ? 'jsonstore' : 'json',
            terminal: this.getTerminal(),
            session: this.getSession(),
        }, args.timeout, args.specific, function(eobj, data, used_conn) {
            if (!args.idle) console.log( 'API Response -', args.action, 'v' + args.version, args.params, eobj, data );

            if (eobj && eobj.code == 'dispatcher_shutdown') {
                console.log( 'Reissuing',args.action,'because dispatcher shut down explicitly without handling it' );
                return me.request(args);
            }

            if (eobj && eobj.data && eobj.data.dispatch_failure && !args.specific) {
                args.specific = me._conn_set.randomStandbyConnection();
                if (args.specific) {
                    console.log('Retrying',args.action,'on another dispatcher');
                    return me.request(args);
                }
            }

            var res;
            if (args.callback) res = args.callback.call(args.scope, data, eobj, !eobj);
            if (eobj && res !== false && !eobj.handled) me.remoteException(eobj.code, eobj.message);
        });
    },

    // this should probably be moved to an event handler in the nav
    remoteException: function(code, message) {
        console.log( 'API exception', code, message );

        if ( code == 'authn' && window.gtAuthenticated ) {
            top.location = '/login';
            return;
        }
        if( code == 'authz' || code == 'authn' ){
            message = message.replace(/access denied\s*-?\s*/i,'');
            nav.addMessage('Access Denied', message || 'Unable to complete the requested action due to insufficient access');
            return;
        }

        Ext.Msg.show({
            title:   'REMOTE EXCEPTION',
            msg:     message,
            icon:    Ext.Msg.ERROR,
            buttons: Ext.Msg.OK
        });
    },

    getConnectionInfo: function(all) { return this._manager.getConnectionInfo(all); },
    setUserPref: function (auth) {
        window.localStorage.setItem('gt.user-node-override', auth);
        this._manager.setUserPref(auth);
    },
}, function () {
    GT.call = GT.api.call = Ext.Function.alias(GT.api.Client, "call");
    GT.api.onAPI = Ext.Function.alias(GT.api.Client, "onAPI");

    window.API = window;
    window.GTAPI = window;
});
