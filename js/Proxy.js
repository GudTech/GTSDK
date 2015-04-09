Ext.define('GT.api.Proxy', {
    extend: 'Ext.data.proxy.Server',
    alias: 'proxy.ropapi',
    requires: 'GT.api.Client',

    constructor: function (config) {
        this.callParent(arguments);

        this.requestsInflight = 0;
        this.queuedOperations = [];
    },

    buildUrl: function() { return ''; },

    doRequest: function(operation, callback, scope) {
        var writer  = this.getWriter(),
            request = this.buildRequest(operation, callback, scope);

        if (operation.allowWrite()) {
            request = writer.write(request);
        }

        this.requestsInflight++;
        GT.api.Client.request({
            action:   this.namespace + '._' + request.action,
            version:  this.version || 1,
            store:    true,
            idle:     this.permitLogout,
            timeout:  65000, // ignore this.timeout - 5 seconds longer than SOA timeout
            params:   Ext.apply(Ext.apply({}, request.params || {}), request.jsonData || {}),
            callback: this.createRequestCallback(request, operation, callback, scope),
        });

        return request;
    },

    createRequestCallback: function(request, operation, callback, scope) {
        var me = this;

        return function(reply, error) {
            me.processResponse(Boolean(reply), operation, request, reply || { FAKE: true, ERROR: error }, callback, scope);
            if ((--me.requestsInflight) <= 0) {
                var queue = Ext.Array.splice(me.queuedOperations, 0);
                var op;
                while (op = queue.shift()) {
                    op[1].callee.apply(op[0], op[1]);
                }
            }
        };
    },

    queueIfBusy: function (scope, args) {
        if (this.requestsInflight > 0) {
            this.queuedOperations.push([scope, args]);
            return true;
        }
        return false;
    },
});
