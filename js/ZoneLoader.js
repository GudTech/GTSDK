Ext.define('GT.api.ZoneLoader', {
    singleton: true,

    _shuffle: function (array) {
        var ix, jx, t, len = array.length;
        for (ix = 0; ix < len; ix++) {
            jx = ix + Math.floor(Math.random() * (len - ix));
            t = array[jx];
            array[jx] = array[ix];
            array[ix] = t;
        }
    },

    parseZone: function (category, tailored, data, manager) {
        var all = [], prio = [], balance = [], me = this;


        try {
            if (!tailored) me._shuffle(data.zones); // load balancing
            Ext.Array.forEach(data.zones, function (zone) {
                me._shuffle(zone.nodes); // unconditionally balance WITHIN zones
                var auths = [];

                Ext.Array.forEach(zone.nodes, function (node, i) {
                    all.push({
                        authority: ""+node.authority,
                        shortname: ""+node.shortname,
                        zonename:  ""+zone.name,
                    });
                    (i < 2 ? auths : balance).push(""+node.authority);
                });
                prio.push(auths);
            });
        } catch (e) {
            console.log('zoneboot - failure to parse',e);
            return false;
        }

        if (balance.length) prio.push(balance);

        console.log('zoneboot - parsed',Ext.encode(all),prio);
        manager.assertNodes(all);
        manager.setPriorityList(category,prio);
        console.log('zoneboot - loaded');
        return true;
    },

    loadBootstrapZone: function (url, manager, callback) {
        console.log('zoneboot - request',url);
        Ext.Ajax.request({
            url: url,
            scope: this,
            callback: function (obj, success, response) {
                var data;
                try { data = Ext.decode(response.responseText); } catch (e) { }

                if (success && data) {
                    return callback(this.parseZone( 'fallback', false, data, manager ));
                } else {
                    console.log('zoneboot FAIL',response,data);
                    return callback(false);
                }
            },
        });
    },
});
