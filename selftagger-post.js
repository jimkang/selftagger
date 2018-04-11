/* global process */

var config = require('./config');
// var config = require('./test-config');

var Twit = require('twit');
var waterfall = require('async-waterfall');
var fs = require('fs');
var queue = require('d3-queue').queue;
var randomId = require('idmaker').randomId;
var StaticWebArchiveOnGit = require('static-web-archive-on-git');
var request = require('request');
var sb = require('standard-bail')();
var postImage = require('post-image-to-twitter');
var probable = require('probable');

const imgLinkRegex = /Size of this preview: <a href="([^"]+)\"(\s)/;
const apiURL =
  'https://vision.googleapis.com/v1/images:annotate?key=' +
  config.googleVisionAPIKey;

var staticWebStream = StaticWebArchiveOnGit({
  config: config.github,
  title: 'Self-tagging bot archives',
  footerScript: `<script type="text/javascript">
  (function(i,s,o,g,r,a,m){i['GoogleAnalyticsObject']=r;i[r]=i[r]||function(){
  (i[r].q=i[r].q||[]).push(arguments)},i[r].l=1*new Date();a=s.createElement(o),m=s.getElementsByTagName(o)[0];a.async=1;a.src=g;m.parentNode.insertBefore(a,m)
  })(window,document,'script','//www.google-analytics.com/analytics.js','ga');

  ga('create', 'UA-49491163-1', 'jimkang.com');
  ga('send', 'pageview');
</script>`,
  maxEntriesPerPage: 20
});

var dryRun = false;

if (process.argv.length > 2) {
  dryRun = process.argv.indexOf('--dry') !== -1;
}

//var twit = new Twit(config.twitter);

waterfall([obtainImage, makeTagComment, postToTargets], wrapUp);

function obtainImage(done) {
  var reqOpts = {
    method: 'GET',
    url: 'http://commons.wikimedia.org/wiki/Special:Random/File'
  };
  request(reqOpts, sb(getImageFromPage, done));

  function getImageFromPage(res, body) {
    var result = imgLinkRegex.exec(body);
    if (result.length < 1) {
      done(new Error('Could not find image link.'));
    } else {
      var imgLink = result[1];
      var imgReqOpts = {
        method: 'GET',
        url: imgLink,
        encoding: null
      };
      //console.log('imgLink', imgLink);
      request(imgReqOpts, sb(passBuffer, done));
    }
  }

  function passBuffer(res, buffer) {
    done(null, buffer);
  }
}

function makeTagComment(buffer, done) {
  var requestOpts = {
    url: apiURL,
    method: 'POST',
    json: true,
    body: createPostBody(buffer.toString('base64'))
  };
  request(requestOpts, sb(makeTagWithLabel, done));

  function makeTagWithLabel(response, body) {
    //console.log('body:', JSON.stringify(body, null, 2));
    var tag = probable.pickFromArray(body.responses[0].labelAnnotations)
      .description;
    done(null, { comment: `tag ur self I'm a ${tag}`, tag, buffer });
  }
}

function createPostBody(base64encodedImage) {
  return {
    requests: [
      {
        image: {
          content: base64encodedImage
        },
        features: [
          {
            type: 'LABEL_DETECTION',
            maxResults: 100
          }
        ]
      }
    ]
  };
}

function postToTargets({ comment, tag, buffer }, done) {
  var q = queue();
  //q.defer(postLinkFindingImage, linkResult);
  q.defer(postToArchive, { comment, tag, buffer });
  q.await(done);
}

/*
function postLinkFindingImage(linkResult, done) {
  var postImageOpts = {
    twit,
    dryRun,
    base64Image: linkResult.base64Image,
    altText: linkResult.concept
    //    caption: dooDooDooDoo()
  };

  if (dryRun) {
    const filename =
      'would-have-posted-' +
      new Date().toISOString().replace(/:/g, '-') +
      '.png';
    console.log('Writing out', filename);
    fs.writeFileSync(filename, postImageOpts.base64Image, {
      encoding: 'base64'
    });
    process.exit();
  } else {
    postImage(postImageOpts, done);
  }
}
*/

function postToArchive({ comment, tag, buffer }, done) {
  var id = tag.replace(/ /g, '-') + randomId(8);
  staticWebStream.write({
    id,
    date: new Date().toISOString(),
    mediaFilename: id + '.jpg',
    caption: comment,
    buffer
  });
  staticWebStream.end(done);
}

function wrapUp(error, data) {
  if (error) {
    console.log(error, error.stack);

    if (data) {
      console.log('data:', data);
    }
  } else {
    // Technically, the user wasn't replied to, but good enough.
    // lastTurnRecord.recordTurn(callOutId, new Date(), reportRecording);
  }
}